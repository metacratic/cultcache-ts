import { useEffect, useRef } from "react";

type Brush = {
  x: number;
  y: number;
  size: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  energy: number;
  curve: number;
  gx: number;
  gy: number;
};

type FieldSample = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  luma: Float32Array;
  alpha: Float32Array;
};

type PyramidLevel = {
  width: number;
  height: number;
  values: Float32Array;
  energy: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
  curve: Float32Array;
};

const FIELD_SIZE = 64;
const MAX_DEPTH = 6;
const MIN_BRUSH_SIZE = 2;
const ENERGY_SPLIT_THRESHOLD = 0.045;

export function HuginnFieldCanvas({ imageUrl }: { imageUrl: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.src = imageUrl;

    const render = async () => {
      try {
        await image.decode();
      } catch {
        return;
      }
      if (cancelled) {
        return;
      }

      const sample = sampleImage(image);
      const pyramid = buildCurvaturePyramid(sample);
      const brushes = buildBrushes(sample, pyramid);
      const observer = new ResizeObserver(() => drawField(canvas, brushes, sample));
      observer.observe(canvas);
      drawField(canvas, brushes, sample);

      return () => observer.disconnect();
    };

    let cleanup: (() => void) | undefined;
    void render().then((nextCleanup) => {
      cleanup = nextCleanup;
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [imageUrl]);

  return <canvas ref={canvasRef} className="huginn-field-canvas" aria-hidden="true" />;
}

function sampleImage(image: HTMLImageElement): FieldSample {
  const canvas = document.createElement("canvas");
  canvas.width = FIELD_SIZE;
  canvas.height = FIELD_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D context unavailable.");
  }

  context.clearRect(0, 0, FIELD_SIZE, FIELD_SIZE);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, FIELD_SIZE, FIELD_SIZE);
  const rgba = context.getImageData(0, 0, FIELD_SIZE, FIELD_SIZE).data;
  const luma = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  const alpha = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  for (let index = 0; index < luma.length; index += 1) {
    const source = index * 4;
    const a = rgba[source + 3] / 255;
    alpha[index] = a;
    luma[index] = (
      rgba[source] * 0.2126 +
      rgba[source + 1] * 0.7152 +
      rgba[source + 2] * 0.0722
    ) / 255 * a;
  }

  return { width: FIELD_SIZE, height: FIELD_SIZE, rgba, luma, alpha };
}

function buildCurvaturePyramid(sample: FieldSample): PyramidLevel[] {
  const levels: PyramidLevel[] = [];
  let width = sample.width;
  let height = sample.height;
  let values = sample.luma;

  for (let level = 0; level < 5; level += 1) {
    const gx = new Float32Array(width * height);
    const gy = new Float32Array(width * height);
    const curve = new Float32Array(width * height);
    const energy = new Float32Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const left = scalarAt(values, width, height, x - 1, y);
        const right = scalarAt(values, width, height, x + 1, y);
        const up = scalarAt(values, width, height, x, y - 1);
        const down = scalarAt(values, width, height, x, y + 1);
        const center = scalarAt(values, width, height, x, y);
        const index = y * width + x;
        const dx = (right - left) * 0.5;
        const dy = (down - up) * 0.5;
        const laplace = Math.abs(left + right + up + down - center * 4);
        gx[index] = dx;
        gy[index] = dy;
        curve[index] = laplace;
        energy[index] = Math.sqrt(dx * dx + dy * dy) * 0.72 + laplace * 0.92;
      }
    }

    normalize(energy);
    normalize(curve);
    levels.push({ width, height, values, energy, gx, gy, curve });

    if (Math.min(width, height) <= 8) {
      break;
    }
    values = downsampleHalf(values, width, height);
    width = Math.ceil(width / 2);
    height = Math.ceil(height / 2);
  }

  return levels;
}

function buildBrushes(sample: FieldSample, pyramid: PyramidLevel[]): Brush[] {
  const brushes: Brush[] = [];
  splitCell(sample, pyramid, brushes, 0, 0, sample.width, 0);
  return brushes.sort((left, right) => left.size - right.size);
}

function splitCell(
  sample: FieldSample,
  pyramid: PyramidLevel[],
  brushes: Brush[],
  x: number,
  y: number,
  size: number,
  depth: number,
): void {
  const stats = cellStats(sample, pyramid[0], x, y, size);
  const shouldSplit =
    depth < MAX_DEPTH &&
    size > MIN_BRUSH_SIZE &&
    (stats.energy > ENERGY_SPLIT_THRESHOLD || stats.alphaVariance > 0.028 || stats.lumaVariance > 0.022);

  if (shouldSplit) {
    const half = Math.max(1, Math.floor(size / 2));
    splitCell(sample, pyramid, brushes, x, y, half, depth + 1);
    splitCell(sample, pyramid, brushes, x + half, y, size - half, depth + 1);
    splitCell(sample, pyramid, brushes, x, y + half, size - half, depth + 1);
    splitCell(sample, pyramid, brushes, x + half, y + half, size - half, depth + 1);
    return;
  }

  if (stats.alpha < 0.035 && stats.energy < 0.02) {
    return;
  }

  const field = sampleVector(pyramid, x + size * 0.5, y + size * 0.5, depth);
  brushes.push({
    x: (x + size * 0.5) / sample.width,
    y: (y + size * 0.5) / sample.height,
    size: size / sample.width,
    r: stats.r,
    g: stats.g,
    b: stats.b,
    alpha: Math.min(0.82, 0.12 + stats.alpha * 0.7 + stats.energy * 0.32),
    energy: stats.energy,
    curve: field.curve,
    gx: field.gx,
    gy: field.gy,
  });
}

function drawField(canvas: HTMLCanvasElement, brushes: Brush[], sample: FieldSample): void {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * scale));
  const height = Math.max(1, Math.floor(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.globalCompositeOperation = "source-over";
  context.fillStyle = "#03070a";
  context.fillRect(0, 0, rect.width, rect.height);

  const logoBox = fitContain(sample.width, sample.height, rect.width, rect.height);
  drawLogoWash(context, logoBox);
  context.globalCompositeOperation = "lighter";

  for (const brush of brushes) {
    const distortion = Math.min(24, 5 + brush.curve * 20);
    const x = logoBox.x + brush.x * logoBox.width + brush.gx * distortion;
    const y = logoBox.y + brush.y * logoBox.height + brush.gy * distortion;
    const radius = Math.max(1.4, brush.size * logoBox.width * (0.56 + brush.energy * 0.55));
    drawSdfBrush(context, x, y, radius, brush);
  }

  context.globalCompositeOperation = "screen";
  context.strokeStyle = "rgba(51, 230, 243, 0.09)";
  context.lineWidth = 1;
  for (let x = logoBox.x; x <= logoBox.x + logoBox.width; x += logoBox.width / 24) {
    context.beginPath();
    context.moveTo(x, logoBox.y);
    context.lineTo(x, logoBox.y + logoBox.height);
    context.stroke();
  }
  for (let y = logoBox.y; y <= logoBox.y + logoBox.height; y += logoBox.height / 24) {
    context.beginPath();
    context.moveTo(logoBox.x, y);
    context.lineTo(logoBox.x + logoBox.width, y);
    context.stroke();
  }
}

function drawSdfBrush(context: CanvasRenderingContext2D, x: number, y: number, radius: number, brush: Brush): void {
  const color = `rgb(${Math.round(brush.r)}, ${Math.round(brush.g)}, ${Math.round(brush.b)})`;
  const glow = context.createRadialGradient(x, y, 0, x, y, radius * 2.5);
  glow.addColorStop(0, `rgba(${Math.round(brush.r)}, ${Math.round(brush.g)}, ${Math.round(brush.b)}, ${brush.alpha})`);
  glow.addColorStop(0.38, `rgba(51, 230, 243, ${brush.alpha * 0.24})`);
  glow.addColorStop(1, "rgba(51, 230, 243, 0)");
  context.fillStyle = glow;
  context.beginPath();
  context.arc(x, y, radius * 2.5, 0, Math.PI * 2);
  context.fill();

  const corner = radius * (0.22 + brush.curve * 0.48);
  context.save();
  context.translate(x, y);
  context.rotate(Math.atan2(brush.gy, brush.gx) * 0.38);
  context.fillStyle = color;
  context.globalAlpha = brush.alpha * 0.42;
  roundedRect(context, -radius, -radius * 0.74, radius * 2, radius * 1.48, corner);
  context.fill();
  context.restore();
}

function drawLogoWash(context: CanvasRenderingContext2D, box: { x: number; y: number; width: number; height: number }) {
  const gradient = context.createRadialGradient(
    box.x + box.width * 0.5,
    box.y + box.height * 0.58,
    box.width * 0.08,
    box.x + box.width * 0.5,
    box.y + box.height * 0.58,
    box.width * 0.62,
  );
  gradient.addColorStop(0, "rgba(51, 230, 243, 0.18)");
  gradient.addColorStop(0.48, "rgba(8, 56, 73, 0.22)");
  gradient.addColorStop(1, "rgba(2, 5, 8, 0)");
  context.fillStyle = gradient;
  context.fillRect(box.x, box.y, box.width, box.height);
}

function cellStats(sample: FieldSample, level: PyramidLevel, x: number, y: number, size: number) {
  let r = 0;
  let g = 0;
  let b = 0;
  let alpha = 0;
  let luma = 0;
  let energy = 0;
  let count = 0;
  const maxY = Math.min(sample.height, y + size);
  const maxX = Math.min(sample.width, x + size);
  for (let yy = y; yy < maxY; yy += 1) {
    for (let xx = x; xx < maxX; xx += 1) {
      const index = yy * sample.width + xx;
      const source = index * 4;
      const a = sample.alpha[index];
      r += sample.rgba[source] * a;
      g += sample.rgba[source + 1] * a;
      b += sample.rgba[source + 2] * a;
      alpha += a;
      luma += sample.luma[index];
      energy += level.energy[index];
      count += 1;
    }
  }
  const safeCount = Math.max(1, count);
  const meanAlpha = alpha / safeCount;
  const meanLuma = luma / safeCount;
  let alphaVariance = 0;
  let lumaVariance = 0;
  for (let yy = y; yy < maxY; yy += 1) {
    for (let xx = x; xx < maxX; xx += 1) {
      const index = yy * sample.width + xx;
      alphaVariance += Math.abs(sample.alpha[index] - meanAlpha);
      lumaVariance += Math.abs(sample.luma[index] - meanLuma);
    }
  }
  const colorWeight = Math.max(0.001, alpha);
  return {
    r: Math.max(18, r / colorWeight),
    g: Math.max(32, g / colorWeight),
    b: Math.max(40, b / colorWeight),
    alpha: meanAlpha,
    energy: energy / safeCount,
    alphaVariance: alphaVariance / safeCount,
    lumaVariance: lumaVariance / safeCount,
  };
}

function sampleVector(pyramid: PyramidLevel[], x: number, y: number, depth: number) {
  const level = pyramid[Math.min(pyramid.length - 1, Math.max(0, Math.floor(depth / 2)))] ?? pyramid[0];
  const sx = Math.max(0, Math.min(level.width - 1, Math.floor(x / FIELD_SIZE * level.width)));
  const sy = Math.max(0, Math.min(level.height - 1, Math.floor(y / FIELD_SIZE * level.height)));
  const index = sy * level.width + sx;
  return {
    gx: level.gx[index] * 90,
    gy: level.gy[index] * 90,
    curve: level.curve[index],
  };
}

function downsampleHalf(values: Float32Array, width: number, height: number): Float32Array {
  const nextWidth = Math.ceil(width / 2);
  const nextHeight = Math.ceil(height / 2);
  const next = new Float32Array(nextWidth * nextHeight);
  for (let y = 0; y < nextHeight; y += 1) {
    for (let x = 0; x < nextWidth; x += 1) {
      next[y * nextWidth + x] = (
        scalarAt(values, width, height, x * 2, y * 2) +
        scalarAt(values, width, height, x * 2 + 1, y * 2) +
        scalarAt(values, width, height, x * 2, y * 2 + 1) +
        scalarAt(values, width, height, x * 2 + 1, y * 2 + 1)
      ) * 0.25;
    }
  }
  return next;
}

function scalarAt(values: Float32Array, width: number, height: number, x: number, y: number): number {
  const sx = Math.max(0, Math.min(width - 1, x));
  const sy = Math.max(0, Math.min(height - 1, y));
  return values[sy * width + sx] ?? 0;
}

function normalize(values: Float32Array): void {
  let max = 0;
  for (const value of values) {
    max = Math.max(max, value);
  }
  if (max <= 0.000001) {
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    values[index] /= max;
  }
}

function fitContain(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight) * 1.04;
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) * 0.5,
    y: (targetHeight - height) * 0.5,
    width,
    height,
  };
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
}
