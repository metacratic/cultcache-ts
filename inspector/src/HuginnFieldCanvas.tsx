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
  fieldRgba: Uint8ClampedArray;
  luma: Float32Array;
  alpha: Float32Array;
  analysis: Float32Array;
  flowX: Float32Array;
  flowY: Float32Array;
  fieldStrength: Float32Array;
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

const FIELD_SIZE = 256;
const MAX_DEPTH = 6;
const MIN_BRUSH_SIZE = 4;
const ENERGY_SPLIT_THRESHOLD = 0.038;
const PARTICLE_COUNT = new URLSearchParams(globalThis.location?.search ?? "").has("smoke") ? 8_192 : 65_536;
const PARTICLE_STRIDE_FLOATS = 12;
const MAX_NODE_ENVELOPES = 96;

type NodeEnvelope = {
  id: string;
  x: number;
  y: number;
  radius: number;
  strength: number;
};

type GraphViewportTransform = {
  x: number;
  y: number;
  scale: number;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

const gpuParticleComputeShader = /* wgsl */ `
struct Particle {
  position: vec2f,
  velocity: vec2f,
  color: vec4f,
  seed: f32,
  size: f32,
  life: f32,
  pad: f32,
};

struct SimUniforms {
  time: f32,
  dt: f32,
  width: f32,
  height: f32,
  particleCount: f32,
  flowGain: f32,
  alpha: f32,
  detail: f32,
  envelopeCount: f32,
  nodeGain: f32,
  worldX: f32,
  worldY: f32,
  worldWidth: f32,
  worldHeight: f32,
  viewX: f32,
  viewY: f32,
  viewScale: f32,
  pad1: f32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> uniforms: SimUniforms;
@group(0) @binding(2) var fieldSampler: sampler;
@group(0) @binding(3) var fieldTexture: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> nodeEnvelopes: array<vec4f>;
@group(0) @binding(5) var albedoTexture: texture_2d<f32>;

fn hash(value: f32) -> f32 {
  return fract(sin(value * 12.9898) * 43758.5453);
}

fn quadtreeCellsBeforeLevel(level: u32) -> u32 {
  var total = 0u;
  var cells = 1u;
  for (var current = 0u; current < 8u; current = current + 1u) {
    if (current >= level) {
      break;
    }
    total = total + cells;
    cells = cells * 4u;
  }
  return total;
}

fn maxQuadtreeLevelForPairs(pairCount: u32) -> u32 {
  var level = 0u;
  var total = 1u;
  var cells = 1u;
  for (var next = 1u; next < 8u; next = next + 1u) {
    cells = cells * 4u;
    if (total + cells > pairCount) {
      break;
    }
    total = total + cells;
    level = next;
  }
  return level;
}

fn quadtreeLevelForPair(pairIndex: u32, maxLevel: u32) -> u32 {
  var level = 0u;
  var first = 0u;
  var cells = 1u;
  for (var current = 0u; current < 8u; current = current + 1u) {
    if (current > maxLevel) {
      break;
    }
    if (pairIndex < first + cells) {
      level = current;
      break;
    }
    first = first + cells;
    cells = cells * 4u;
  }
  return level;
}

fn wrap2(value: vec2f, size: vec2f) -> vec2f {
  return fract(value / size) * size;
}

fn proceduralCurl(point: vec2f, seed: f32) -> vec2f {
  let angle =
    sin(point.x * 0.011 + uniforms.time * 0.23 + seed * 6.28318) +
    cos(point.y * 0.017 - uniforms.time * 0.19 + seed * 4.71) +
    sin((point.x + point.y) * 0.006 + uniforms.time * 0.11) +
    sin(point.x * 0.041 + point.y * -0.032 + uniforms.time * 0.37 + seed);
  return vec2f(cos(angle * 3.14159), sin(angle * 3.14159));
}

fn samplePacked(uv: vec2f) -> vec4f {
  return textureSampleLevel(fieldTexture, fieldSampler, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0);
}

fn sampleAlbedo(uv: vec2f) -> vec4f {
  return textureSampleLevel(albedoTexture, fieldSampler, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0);
}

fn channelGradient(uv: vec2f, channel: u32) -> vec2f {
  let step = vec2f(1.0 / 256.0, 1.0 / 256.0) / max(uniforms.detail, 1.0);
  let left = samplePacked(uv - vec2f(step.x, 0.0));
  let right = samplePacked(uv + vec2f(step.x, 0.0));
  let up = samplePacked(uv - vec2f(0.0, step.y));
  let down = samplePacked(uv + vec2f(0.0, step.y));
  if (channel == 2u) {
    return vec2f(right.b - left.b, down.b - up.b);
  }
  return vec2f(right.a - left.a, down.a - up.a);
}

@compute @workgroup_size(128)
fn updateParticles(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= u32(uniforms.particleCount)) {
    return;
  }

  var particle = particles[index];
  let pairIndex = index / 2u;
  let companion = index - pairIndex * 2u;
  let pairCount = max(1u, u32(uniforms.particleCount * 0.5));
  let pairCapacityLevel = maxQuadtreeLevelForPairs(pairCount);
  let zoomLevel = u32(clamp(floor(log2(max(uniforms.viewScale, 0.25)) * 0.9 + uniforms.detail * 0.75 + 4.25), 2.0, 7.0));
  let activeLevel = min(pairCapacityLevel, zoomLevel);
  let activePairs = min(pairCount, quadtreeCellsBeforeLevel(activeLevel + 1u));
  if (pairIndex >= activePairs) {
    particle.color = vec4f(0.0);
    particle.size = 0.0;
    particles[index] = particle;
    return;
  }

  let level = quadtreeLevelForPair(pairIndex, activeLevel);
  let levelFirstPair = quadtreeCellsBeforeLevel(level);
  let localPair = pairIndex - levelFirstPair;
  let span = 1u << level;
  let cell = vec2f(f32(localPair % span), f32(localPair / span));
  let cellHashSeed = f32(level) * 4096.0 + cell.x * 131.0 + cell.y * 719.0;
  let seed = hash(cellHashSeed + f32(companion) * 17.0);
  let cellJitter = vec2f(hash(cellHashSeed + 11.0), hash(cellHashSeed + 23.0));
  let base = (cell + cellJitter) / f32(span);

  var packed = samplePacked(base);
  let levelDetail = f32(level) / max(f32(activeLevel), 1.0);
  let detail = clamp(uniforms.detail, 0.75, 2.0);
  let fieldVector = packed.rg * 2.0 - vec2f(1.0);
  let fieldDirection = normalize(fieldVector + vec2f(0.0001, 0.0));
  let drift = fieldDirection * uniforms.time * (uniforms.flowGain / 24.0) * (0.00055 + packed.a * 0.0011 + packed.b * 0.0004) / max(f32(span), 1.0);
  var uv = wrap2(base + drift, vec2f(1.0));
  packed = samplePacked(uv);

  let curvatureGradient = channelGradient(uv, 2u);
  let tangent = normalize(vec2f(-curvatureGradient.y, curvatureGradient.x) + fieldDirection * 0.28 + vec2f(0.0001, 0.0));
  let fieldBlend = normalize(fieldDirection * 0.74 + tangent * (0.26 + packed.b * 0.18));
  var nodePush = vec2f(0.0);
  var nodeHeat = 0.0;
  for (var envelopeIndex = 0u; envelopeIndex < ${MAX_NODE_ENVELOPES}u; envelopeIndex = envelopeIndex + 1u) {
    if (f32(envelopeIndex) >= uniforms.envelopeCount) {
      break;
    }
    let envelope = nodeEnvelopes[envelopeIndex];
    let delta = uv - envelope.xy;
    let radius = max(envelope.z, 0.008);
    let normalized = dot(delta, delta) / (radius * radius);
    let edge = exp(-4.0);
    let gaussian = exp(-4.0 * normalized);
    let influence = pow(clamp((gaussian - edge) / max(1.0 - edge, 0.000001), 0.0, 1.0), 0.92) * envelope.w * uniforms.nodeGain;
    let away = normalize(delta + vec2f(0.0001, 0.0));
    let swirl = vec2f(-away.y, away.x);
    nodePush += (swirl * 0.72 + away * 0.18) * influence;
    nodeHeat += influence;
  }

  let period = 5.2 + hash(seed * 53.0) * 1.8 + levelDetail * 0.8;
  let phase = uniforms.time / period + seed;
  let wave = phase * 6.28318;
  let sine = sin(wave) * 0.5 + 0.5;
  let cosine = cos(wave) * 0.5 + 0.5;
  let fade = select(sine * sine, cosine * cosine, companion == 1u);
  let side = select(-1.0, 1.0, companion == 1u);
  let shimmer = sin(wave * 1.7 + packed.b * 4.0) * 0.5 + 0.5;
  let flowLine = normalize(fieldBlend + nodePush + proceduralCurl(uv * 54.0, seed) * 0.045);
  let normal = vec2f(-flowLine.y, flowLine.x);
  let worldSpan = max(max(uniforms.worldWidth, uniforms.worldHeight), 1.0);
  let cellUv = 1.0 / max(f32(span), 1.0);
  let linePixels = (3.0 + packed.a * 8.5 + packed.b * 4.0 + nodeHeat * 2.0) * (0.94 + detail * 0.05);
  let lineUv = min(linePixels / worldSpan, cellUv * 0.28);
  let trace = (side * 0.42 + (fract(phase) - 0.5) * 0.32) * lineUv;
  let tremble = (shimmer - 0.5) * lineUv * 0.26;
  uv = clamp(uv + flowLine * trace + normal * tremble, vec2f(0.001), vec2f(0.999));
  packed = samplePacked(uv);

  particle.position = uv;
  particle.velocity = flowLine * (linePixels * 0.42 + 1.0);
  particle.life = fade;

  let flowAxis = abs(fieldVector.x - fieldVector.y);
  let heat = clamp(packed.a * 0.78 + packed.b * 0.62 + nodeHeat * 0.38 + fade * 0.18, 0.0, 1.0);
  let brass = clamp((packed.b - packed.a * 0.32) * 1.35 + flowAxis * 0.18, 0.0, 1.0);
  let albedo = sampleAlbedo(uv);
  let cyan = vec3f(0.08 + heat * 0.28, 0.44 + heat * 0.46, 0.52 + heat * 0.62);
  let gold = vec3f(0.86, 0.58, 0.22);
  let deep = vec3f(0.02, 0.10, 0.12);
  let albedoLift = mix(deep, albedo.rgb, clamp(albedo.a * (0.72 + heat * 0.24), 0.0, 1.0));
  let fieldTint = mix(cyan, gold, brass * 0.26);
  let rgb = mix(albedoLift, fieldTint, 0.18 + heat * 0.16);
  particle.color = vec4f(
    rgb,
    uniforms.alpha * (0.0022 + heat * 0.008 + packed.a * 0.005 + nodeHeat * 0.0025) * fade * (0.72 + levelDetail * 0.28)
  );
  particle.size = (0.3 + hash(seed * 19.0) * 0.68) * (0.68 + packed.a * 0.52 + packed.b * 0.24 + nodeHeat * 0.14) * (0.92 + detail * 0.035) * (0.82 + levelDetail * 0.22);
  particles[index] = particle;
}
`;

const gpuParticleRenderShader = /* wgsl */ `
struct Particle {
  position: vec2f,
  velocity: vec2f,
  color: vec4f,
  seed: f32,
  size: f32,
  life: f32,
  pad: f32,
};

struct SimUniforms {
  time: f32,
  dt: f32,
  width: f32,
  height: f32,
  particleCount: f32,
  flowGain: f32,
  alpha: f32,
  detail: f32,
  envelopeCount: f32,
  nodeGain: f32,
  worldX: f32,
  worldY: f32,
  worldWidth: f32,
  worldHeight: f32,
  viewX: f32,
  viewY: f32,
  viewScale: f32,
  pad1: f32,
};

@group(0) @binding(0) var<storage, read> renderParticles: array<Particle>;
@group(0) @binding(1) var<uniform> renderUniforms: SimUniforms;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) local: vec2f,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOut {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, -1.0),
    vec2f(1.0, 1.0)
  );
  let particle = renderParticles[instanceIndex];
  let local = corners[vertexIndex];
  let direction = normalize(particle.velocity + vec2f(0.001, 0.0));
  let tangent = vec2f(-direction.y, direction.x);
  let stretch = clamp(length(particle.velocity) / 16.0, 0.0, 1.4);
  let ellipse = direction * local.x * particle.size * (1.0 + stretch * 0.62) + tangent * local.y * particle.size * (0.64 + renderUniforms.detail * 0.025);
  let world = vec2f(renderUniforms.worldX, renderUniforms.worldY) + particle.position * vec2f(renderUniforms.worldWidth, renderUniforms.worldHeight);
  let viewScale = max(renderUniforms.viewScale, 0.05);
  let basePosition = vec2f(renderUniforms.viewX, renderUniforms.viewY) + world * viewScale;
  let pixelPosition = basePosition + ellipse * sqrt(viewScale);
  var out: VertexOut;
  out.position = vec4f((pixelPosition.x / renderUniforms.width) * 2.0 - 1.0, 1.0 - (pixelPosition.y / renderUniforms.height) * 2.0, 0.0, 1.0);
  out.color = particle.color;
  out.local = local;
  return out;
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  let radius2 = dot(input.local, input.local);
  let falloff = 5.1 + renderUniforms.detail * 0.52;
  let edge = exp(-falloff);
  let gaussian = exp(-falloff * radius2);
  let compact = pow(clamp((gaussian - edge) / max(1.0 - edge, 0.000001), 0.0, 1.0), 0.72);
  let core = exp(-radius2 * 18.0) * 0.42;
  return vec4f(input.color.rgb * (compact * 1.52 + core), input.color.a * compact);
}
`;

type HuginnFieldCanvasProps = {
  imageUrl: string;
  fieldUrl: string;
};

export function HuginnFieldCanvas({ imageUrl, fieldUrl }: HuginnFieldCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let cancelled = false;
    const render = async () => {
      try {
        const [image, fieldImage] = await Promise.all([
          loadImage(imageUrl),
          loadImage(fieldUrl),
        ]);
        if (cancelled) {
          return;
        }

        const sample = sampleImage(image, fieldImage);
        const gpuCleanup = await startGpuParticleField(canvas, sample);
        if (gpuCleanup) {
          console.info("Huginn WebGPU particle field active.");
          return gpuCleanup;
        }

        console.info("Huginn WebGPU unavailable; using canvas field fallback.");
        const pyramid = buildCurvaturePyramid(sample);
        const brushes = buildBrushes(sample, pyramid);
        const observer = new ResizeObserver(() => drawFieldFallback(canvas, brushes, sample));
        observer.observe(canvas);
        drawFieldFallback(canvas, brushes, sample);

        return () => observer.disconnect();
      } catch {
        return;
      }
    };

    let cleanup: (() => void) | undefined;
    void render().then((nextCleanup) => {
      cleanup = nextCleanup;
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [fieldUrl, imageUrl]);

  return <canvas ref={canvasRef} className="huginn-field-canvas" aria-hidden="true" />;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  return image.decode()
    .catch(() => new Promise<void>((resolve, reject) => {
      if (image.complete && image.naturalWidth > 0) {
        resolve();
        return;
      }
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Could not load ${url}`));
    }))
    .then(() => image);
}

function sampleImage(
  image: HTMLImageElement,
  fieldImage: HTMLImageElement,
): FieldSample {
  const base = sampleBitmap(image);
  const field = sampleBitmap(fieldImage);
  const analysis = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  const flowX = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  const flowY = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  const fieldStrength = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  for (let index = 0; index < analysis.length; index += 1) {
    const source = index * 4;
    flowX[index] = field.rgba[source] / 255 * 2 - 1;
    flowY[index] = field.rgba[source + 1] / 255 * 2 - 1;
    analysis[index] = field.rgba[source + 2] / 255 * base.alpha[index];
    fieldStrength[index] = field.rgba[source + 3] / 255;
  }

  return {
    width: FIELD_SIZE,
    height: FIELD_SIZE,
    rgba: base.rgba,
    fieldRgba: field.rgba,
    luma: base.luma,
    alpha: base.alpha,
    analysis,
    flowX,
    flowY,
    fieldStrength,
  };
}

function sampleBitmap(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = FIELD_SIZE;
  canvas.height = FIELD_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D context unavailable.");
  }

  context.clearRect(0, 0, FIELD_SIZE, FIELD_SIZE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
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

  return { rgba, luma, alpha };
}

function buildCurvaturePyramid(sample: FieldSample): PyramidLevel[] {
  const levels: PyramidLevel[] = [];
  let width = sample.width;
  let height = sample.height;
  let values = sample.analysis;

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

  const field = sampleVector(sample, pyramid, x + size * 0.5, y + size * 0.5, depth);
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

async function startGpuParticleField(canvas: HTMLCanvasElement, sample: FieldSample): Promise<(() => void) | undefined> {
  const gpu = (navigator as Navigator & { gpu?: any }).gpu;
  if (!gpu) {
    return undefined;
  }

  const context = canvas.getContext("webgpu") as any;
  if (!context) {
    return undefined;
  }

  const adapter = await gpu.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    return undefined;
  }

  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const sampler = device.createSampler({
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    magFilter: "linear",
    minFilter: "linear",
  });
  const fieldTexture = device.createTexture({
    size: [sample.width, sample.height, 1],
    format: "rgba8unorm",
    usage: 1 | 2 | 4,
  });
  const albedoTexture = device.createTexture({
    size: [sample.width, sample.height, 1],
    format: "rgba8unorm",
    usage: 1 | 2 | 4,
  });
  device.queue.writeTexture(
    { texture: fieldTexture },
    sample.fieldRgba,
    { bytesPerRow: sample.width * 4, rowsPerImage: sample.height },
    { width: sample.width, height: sample.height, depthOrArrayLayers: 1 },
  );
  device.queue.writeTexture(
    { texture: albedoTexture },
    sample.rgba,
    { bytesPerRow: sample.width * 4, rowsPerImage: sample.height },
    { width: sample.width, height: sample.height, depthOrArrayLayers: 1 },
  );

  const particleBuffer = device.createBuffer({
    size: PARTICLE_COUNT * PARTICLE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
    usage: 128 | 32 | 8,
    mappedAtCreation: true,
  });
  seedParticles(new Float32Array(particleBuffer.getMappedRange()), PARTICLE_COUNT);
  particleBuffer.unmap();

  const uniformBuffer = device.createBuffer({
    size: 20 * Float32Array.BYTES_PER_ELEMENT,
    usage: 64 | 8,
  });
  const nodeEnvelopeBuffer = device.createBuffer({
    size: MAX_NODE_ENVELOPES * 4 * Float32Array.BYTES_PER_ELEMENT,
    usage: 128 | 8,
  });
  const nodeEnvelopeState = {
    data: new Float32Array(MAX_NODE_ENVELOPES * 4),
    count: 0,
  };
  const transformState: {
    received: boolean;
    current: GraphViewportTransform;
  } = {
    received: false,
    current: { x: 0, y: 0, scale: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } },
  };

  const computeShader = device.createShaderModule({ code: gpuParticleComputeShader });
  const renderShader = device.createShaderModule({ code: gpuParticleRenderShader });
  const computePipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: computeShader, entryPoint: "updateParticles" },
  });
  const renderPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: renderShader, entryPoint: "vertexMain" },
    fragment: {
      module: renderShader,
      entryPoint: "fragmentMain",
      targets: [{ format, blend: { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }],
    },
    primitive: { topology: "triangle-list" },
  });
  const bindGroup = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: uniformBuffer } },
      { binding: 2, resource: sampler },
      { binding: 3, resource: fieldTexture.createView() },
      { binding: 4, resource: { buffer: nodeEnvelopeBuffer } },
      { binding: 5, resource: albedoTexture.createView() },
    ],
  });
  const renderBindGroup = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: uniformBuffer } },
    ],
  });

  let stopped = false;
  let frameId = 0;
  let lastTime = performance.now();
  let detail = 1;
  let targetDetail = 1;
  const resize = () => resizeGpuCanvas(canvas);
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  const detailController = attachDetailController(canvas, (nextDetail) => {
    targetDetail = nextDetail;
  });
  const envelopeListener = attachNodeEnvelopeListener(canvas, nodeEnvelopeState, device, nodeEnvelopeBuffer);
  const transformListener = attachViewportTransformListener(canvas, transformState);

  const frame = (time: number) => {
    if (stopped) {
      return;
    }

    resize();
    const dt = Math.min(0.033, Math.max(0.001, (time - lastTime) / 1000));
    lastTime = time;
    detail += (targetDetail - detail) * Math.min(1, dt * 4.8);
    const activeParticleCount = PARTICLE_COUNT;
    const graphTransform = transformState.received
      ? transformState.current
      : {
          x: 0,
          y: 0,
          scale: 1,
          bounds: { x: 0, y: 0, width: canvas.width, height: canvas.height },
        };
    const bounds = fitArtworkBounds(graphTransform.bounds);
    device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([
      time / 1000,
      dt,
      canvas.width,
      canvas.height,
      activeParticleCount,
      18 + detail * 6,
      0.42,
      detail,
      nodeEnvelopeState.count,
      0.16 + detail * 0.05,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      graphTransform.x,
      graphTransform.y,
      graphTransform.scale,
      0,
    ]));

    const encoder = device.createCommandEncoder();
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(computePipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(Math.ceil(activeParticleCount / 128));
    computePass.end();

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.011, g: 0.027, b: 0.039, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, renderBindGroup);
    renderPass.draw(6, activeParticleCount);
    renderPass.end();
    device.queue.submit([encoder.finish()]);
    frameId = requestAnimationFrame(frame);
  };

  frameId = requestAnimationFrame(frame);
  return () => {
    stopped = true;
    cancelAnimationFrame(frameId);
    observer.disconnect();
    detailController();
    envelopeListener();
    transformListener();
    particleBuffer.destroy();
    uniformBuffer.destroy();
    nodeEnvelopeBuffer.destroy();
    fieldTexture.destroy();
    albedoTexture.destroy();
  };
}

function seedParticles(particles: Float32Array, count: number): void {
  const span = Math.ceil(Math.sqrt(count));
  for (let index = 0; index < count; index += 1) {
    const cellX = index % span;
    const cellY = Math.floor(index / span);
    const seed = hash(index * 19.19 + 3.7);
    const angle = seed * Math.PI * 2;
    const ring = Math.sqrt(hash(seed * 71.0)) * 0.48;
    const latticeX = (cellX + hash(seed * 17.0)) / span;
    const latticeY = (cellY + hash(seed * 29.0)) / span;
    const radialX = 0.5 + Math.cos(angle) * ring + (hash(seed * 97.0) - 0.5) * 0.08;
    const radialY = 0.5 + Math.sin(angle) * ring + (hash(seed * 113.0) - 0.5) * 0.08;
    const radialBias = hash(seed * 41.0);
    const offset = index * PARTICLE_STRIDE_FLOATS;
    particles[offset] = radialBias < 0.64 ? clamp01(radialX) : latticeX;
    particles[offset + 1] = radialBias < 0.64 ? clamp01(radialY) : latticeY;
    particles[offset + 2] = 0;
    particles[offset + 3] = 0;
    particles[offset + 4] = 0.18;
    particles[offset + 5] = 0.72;
    particles[offset + 6] = 0.82;
    particles[offset + 7] = 0.018;
    particles[offset + 8] = seed;
    particles[offset + 9] = 1.4 + hash(seed * 43.0) * 2.2;
    particles[offset + 10] = 0;
    particles[offset + 11] = 0;
  }
}

function hash(value: number): number {
  return fract(Math.sin(value * 12.9898) * 43758.5453);
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function attachDetailController(canvas: HTMLCanvasElement, setDetail: (detail: number) => void): () => void {
  let target = 1;
  let lastInput = performance.now();
  const apply = (detail: number) => {
    target = Math.max(0.7, Math.min(4.0, detail));
    lastInput = performance.now();
    setDetail(target);
  };
  const onWheel = (event: WheelEvent) => {
    apply(target * (event.deltaY < 0 ? 1.22 : 0.86));
  };
  const onPointerMove = () => {
    apply(Math.max(target, 1.55));
  };
  const decay = window.setInterval(() => {
    const idleSeconds = (performance.now() - lastInput) / 1000;
    if (idleSeconds > 1.6) {
      target += (1 - target) * 0.08;
      setDetail(target);
    }
  }, 180);
  const targetElement = canvas.parentElement ?? canvas;
  targetElement.addEventListener("wheel", onWheel, { passive: true });
  targetElement.addEventListener("pointermove", onPointerMove, { passive: true });
  return () => {
    window.clearInterval(decay);
    targetElement.removeEventListener("wheel", onWheel);
    targetElement.removeEventListener("pointermove", onPointerMove);
  };
}

function attachNodeEnvelopeListener(
  canvas: HTMLCanvasElement,
  state: { data: Float32Array; count: number },
  device: any,
  buffer: any,
): () => void {
  const target = canvas.parentElement ?? canvas;
  const onEnvelopes = (event: Event) => {
    const envelopes = (event as CustomEvent<NodeEnvelope[]>).detail;
    if (!Array.isArray(envelopes)) {
      return;
    }
    state.data.fill(0);
    state.count = Math.min(MAX_NODE_ENVELOPES, envelopes.length);
    for (let index = 0; index < state.count; index += 1) {
      const envelope = envelopes[index];
      const offset = index * 4;
      state.data[offset] = clamp01(envelope.x);
      state.data[offset + 1] = clamp01(envelope.y);
      state.data[offset + 2] = Math.max(0.006, Math.min(0.32, envelope.radius));
      state.data[offset + 3] = Math.max(0, Math.min(1.6, envelope.strength));
    }
    device.queue.writeBuffer(buffer, 0, state.data);
  };
  target.addEventListener("epiphanygraph-node-envelopes", onEnvelopes as EventListener);
  return () => target.removeEventListener("epiphanygraph-node-envelopes", onEnvelopes as EventListener);
}

function attachViewportTransformListener(
  canvas: HTMLCanvasElement,
  state: { received: boolean; current: GraphViewportTransform },
): () => void {
  const target = canvas.parentElement ?? canvas;
  const onTransform = (event: Event) => {
    const detail = (event as CustomEvent<Partial<GraphViewportTransform>>).detail;
    if (
      typeof detail?.x !== "number" ||
      typeof detail.y !== "number" ||
      typeof detail.scale !== "number"
    ) {
      return;
    }
    state.current = {
      x: detail.x,
      y: detail.y,
      scale: detail.scale,
      bounds: isGraphBounds(detail.bounds) ? detail.bounds : state.current.bounds,
    };
    state.received = true;
  };
  target.addEventListener("epiphanygraph-viewport-transform", onTransform as EventListener);
  return () => target.removeEventListener("epiphanygraph-viewport-transform", onTransform as EventListener);
}

function isGraphBounds(value: unknown): value is GraphViewportTransform["bounds"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<GraphViewportTransform["bounds"]>;
  return (
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.width === "number" &&
    typeof candidate.height === "number"
  );
}

function fitArtworkBounds(bounds: GraphViewportTransform["bounds"]) {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const side = Math.max(width, height);
  return {
    x: bounds.x + width * 0.5 - side * 0.5,
    y: bounds.y + height * 0.5 - side * 0.5,
    width: side,
    height: side,
  };
}

function resizeGpuCanvas(canvas: HTMLCanvasElement): void {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * scale));
  const height = Math.max(1, Math.floor(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function drawFieldFallback(canvas: HTMLCanvasElement, brushes: Brush[], sample: FieldSample): void {
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

function sampleVector(sample: FieldSample, pyramid: PyramidLevel[], x: number, y: number, depth: number) {
  const level = pyramid[Math.min(pyramid.length - 1, Math.max(0, Math.floor(depth / 2)))] ?? pyramid[0];
  const sx = Math.max(0, Math.min(level.width - 1, Math.floor(x / FIELD_SIZE * level.width)));
  const sy = Math.max(0, Math.min(level.height - 1, Math.floor(y / FIELD_SIZE * level.height)));
  const index = sy * level.width + sx;
  const sourceX = Math.max(0, Math.min(sample.width - 1, Math.floor(x)));
  const sourceY = Math.max(0, Math.min(sample.height - 1, Math.floor(y)));
  const sourceIndex = sourceY * sample.width + sourceX;
  const flowX = sample.flowX[sourceIndex] ?? 0;
  const flowY = sample.flowY[sourceIndex] ?? 0;
  const fieldStrength = sample.fieldStrength[sourceIndex] ?? 0;
  return {
    gx: level.gx[index] * 46 + flowX * 0.72,
    gy: level.gy[index] * 46 + flowY * 0.72,
    curve: Math.max(level.curve[index], fieldStrength),
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
