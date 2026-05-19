import { EpiphanyGraphViewer, type EpiphanyGraphEdge, type EpiphanyGraphNode, type EpiphanyGraphsState, type TerrainForceContext, type TerrainForceSample, type ViewerSelection } from "@epiphanygraph/epiphany-graph-viewer";
import { createRoot } from "react-dom/client";
import { Component, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";

import { inspectCultCacheBytes, type CultCacheInspection, type InspectedCatalogEntry, type InspectedRecord } from "../../src/cult-cache-inspector";
import { HuginnFieldCanvas } from "./HuginnFieldCanvas";
import "./styles.css";

type Selection = {
  record: number;
};

type RawSelection =
  | { kind: "record"; index: number }
  | { kind: "value"; recordIndex: number; path: string; value: unknown };

type GraphProjection = {
  state: EpiphanyGraphsState;
  recordNodeIds: string[];
  nodeSelections: Map<string, RawSelection>;
  edgeSelections: Map<string, RawSelection>;
  truncatedValueNodes: number;
};

type TerrainTexture = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

const MAX_EXPANDED_VALUE_NODES = 960;
const assetPath = (name: string) => `${import.meta.env.BASE_URL}${name}`;
const HUGINN_ART = {
  surface: assetPath("huginn-surface.png"),
  field: assetPath("huginn-fieldpack.png"),
};

function HuginnField() {
  return (
    <HuginnFieldCanvas
      imageUrl={HUGINN_ART.surface}
      fieldUrl={HUGINN_ART.field}
    />
  );
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing inspector app root.");
}

class RenderCrashBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="workspace">
          <section className="sidebar">
            <div className="brand">
              <img src={assetPath("hugin-64.png")} alt="" width="64" height="64" />
              <div>
                <h1>Huginn</h1>
                <p>CultCache state inspection for <code>.cc</code> files.</p>
              </div>
            </div>
          </section>
          <section className="content">
            <div className="error fatal-error">
              <strong>Renderer error</strong>
              <span>{this.state.error}</span>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

createRoot(app).render(
  <RenderCrashBoundary>
    <HuginnApp />
  </RenderCrashBoundary>,
);

function HuginnApp() {
  const [inspection, setInspection] = useState<CultCacheInspection | undefined>();
  const [selection, setSelection] = useState<Selection>({ record: 0 });
  const [graphSelection, setGraphSelection] = useState<ViewerSelection | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [dragging, setDragging] = useState(false);

  const graphProjection = useMemo(
    () => inspection ? buildGraphProjection(inspection) : emptyGraphProjection(),
    [inspection],
  );

  async function inspectFile(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const nextInspection = inspectCultCacheBytes(file.name, bytes, file.size);
      setInspection(nextInspection);
      setSelection({ record: 0 });
      setGraphSelection({
        kind: "node",
        graphKey: "dataflow",
        nodeId: nextInspection.records[0]
          ? recordNodeId(nextInspection.records[0], 0)
          : "store",
      });
      setErrorMessage("");
    } catch (error) {
      setInspection(undefined);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files.item(0);
    if (file) {
      void inspectFile(file);
    }
  }

  return (
    <main
      className={`workspace ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.target === event.currentTarget) {
          setDragging(false);
        }
      }}
      onDrop={handleDrop}
    >
      {inspection
        ? (
          <InspectionView
            errorMessage={errorMessage}
            inspection={inspection}
            graphProjection={graphProjection}
            graphSelection={graphSelection}
            setGraphSelection={setGraphSelection}
            selection={selection}
            setSelection={setSelection}
            onInspectFile={inspectFile}
          />
        )
        : (
          <EmptyWorkspace
            errorMessage={errorMessage}
            onInspectFile={inspectFile}
          />
        )}
    </main>
  );
}

function EmptyWorkspace({
  errorMessage,
  onInspectFile,
}: {
  errorMessage: string;
  onInspectFile: (file: File) => Promise<void>;
}) {
  return (
    <section className="empty-workspace">
      <HuginnField />
      <section className="floating-panel brand-panel is-primary">
        <BrandBlock />
        <FilePicker onInspectFile={onInspectFile} />
        {errorMessage ? <div className="error">{errorMessage}</div> : null}
        <EmptySummary />
      </section>
      <NoFile />
    </section>
  );
}

function BrandBlock() {
  return (
    <div className="brand">
      <img src={assetPath("hugin-64.png")} alt="" width="64" height="64" />
      <div>
        <h1>Huginn</h1>
        <p>CultCache state inspection for <code>.cc</code> files.</p>
      </div>
    </div>
  );
}

function FilePicker({ onInspectFile }: { onInspectFile: (file: File) => Promise<void> }) {
  return (
    <label className="dropzone">
      <input
        type="file"
        accept=".cc,.msgpack,.mpack,application/octet-stream"
        onChange={(event) => {
          const file = event.currentTarget.files?.item(0);
          if (file) {
            void onInspectFile(file);
          }
        }}
      />
      <span className="drop-title">Drop CultCache file</span>
      <span className="drop-copy">or choose one from disk</span>
    </label>
  );
}

function Summary({ inspection }: { inspection: CultCacheInspection }) {
  return (
    <div className="summary">
      <Metric label="Format" value={inspection.format} />
      <Metric label="Records" value={inspection.records.length.toString()} />
      <Metric label="Schemas" value={inspection.catalog.length.toString()} />
      <Metric label="Bytes" value={inspection.fileSizeBytes.toString()} />
    </div>
  );
}

function EmptySummary() {
  return (
    <div className="summary">
      <Metric label="Format" value=".cc" />
      <Metric label="Mode" value="Read-only" />
      <Metric label="Payload" value="MessagePack" />
      <Metric label="Runtime" value="Vite" />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NoFile() {
  return (
    <div className="hero">
      <img src={HUGINN_ART.surface} alt="" />
      <h2>No state loaded</h2>
      <p>Drag a CultCache <code>.cc</code> store into the window to inspect the snapshot header, schema catalog, records, and decoded MessagePack payloads.</p>
    </div>
  );
}

function InspectionView({
  errorMessage,
  inspection,
  graphProjection,
  graphSelection,
  setGraphSelection,
  selection,
  setSelection,
  onInspectFile,
}: {
  errorMessage: string;
  inspection: CultCacheInspection;
  graphProjection: GraphProjection;
  graphSelection: ViewerSelection | null;
  setGraphSelection: (selection: ViewerSelection | null) => void;
  selection: Selection;
  setSelection: (selection: Selection) => void;
  onInspectFile: (file: File) => Promise<void>;
}) {
  const terrainForces = useHuginnTerrainForces(HUGINN_ART.field);
  const expandedRawSelection = graphSelection?.kind === "node"
    ? graphProjection.nodeSelections.get(graphSelection.nodeId)
    : graphSelection?.kind === "edge"
      ? graphProjection.edgeSelections.get(graphSelection.edgeId)
      : undefined;
  const expandedRecord = expandedRawSelection?.kind === "record"
    ? inspection.records[expandedRawSelection.index]
    : expandedRawSelection?.kind === "value"
      ? inspection.records[expandedRawSelection.recordIndex]
      : undefined;
  const expandedValue = expandedRawSelection?.kind === "value"
    ? {
        path: expandedRawSelection.path,
        value: expandedRawSelection.value,
      }
    : undefined;
  const expandedCatalogEntry = expandedRecord
    ? inspection.catalog.find((entry) => entry.schemaId === expandedRecord.schemaId)
    : undefined;
  const expandedNode = graphSelection?.kind === "node"
    ? {
        graphKey: graphSelection.graphKey,
        nodeId: graphSelection.nodeId,
        className: "huginn-expanded-node",
        ariaLabel: "Selected CultCache node",
        content: (
          <ExpandedNodePanel
            catalogEntry={expandedCatalogEntry}
            expandedValue={expandedValue}
            inspection={inspection}
            record={expandedRecord}
          />
        ),
      }
    : undefined;
  const selectRaw = (next: Extract<RawSelection, { kind: "record" }>) => {
    setSelection({ record: next.index });
    setGraphSelection({
      kind: "node",
      graphKey: "dataflow",
      nodeId: graphProjection.recordNodeIds[next.index],
    });
  };
  const selectGraph = (next: ViewerSelection | null) => {
    setGraphSelection(next);
    if (!next) {
      return;
    }

    const rawSelection = next.kind === "node"
      ? graphProjection.nodeSelections.get(next.nodeId)
      : graphProjection.edgeSelections.get(next.edgeId);
    if (!rawSelection) {
      return;
    }

    if (rawSelection.kind === "record") {
      setSelection({ record: rawSelection.index });
      return;
    }
    if (rawSelection.kind === "value") {
      setSelection({ record: rawSelection.recordIndex });
      return;
    }
  };

  return (
    <div className="inspector-stage">
      <section className="graph-panel">
        <EpiphanyGraphViewer
          className="huginn-graph-shell"
          state={graphProjection.state}
          initialGraph="dataflow"
          selection={graphSelection}
          onSelectionChange={selectGraph}
          title="CultCache Structure"
          viewportBackdrop={<HuginnField />}
          viewportBackground="#03070a"
          terrainForces={terrainForces}
          overlayPanels
          showSidebar={false}
          focusSelection
          selectionFocusMode="article"
          expandedNode={expandedNode}
          graphLabels={{ architecture: "File", dataflow: "Payload Cloud" }}
          style={{ minHeight: "100vh" }}
        />
        {graphProjection.truncatedValueNodes > 0 ? (
          <div className="graph-warning">
            Payload cloud clipped after {MAX_EXPANDED_VALUE_NODES} value nodes; {graphProjection.truncatedValueNodes} deeper node(s) omitted from the graph. Raw payload detail remains in the expanded record panel.
          </div>
        ) : null}
      </section>
      <div className="overlay-layer">
        <section className="floating-panel brand-panel">
          <BrandBlock />
          <FilePicker onInspectFile={onInspectFile} />
          {errorMessage ? <div className="error">{errorMessage}</div> : null}
          <Summary inspection={inspection} />
        </section>
        <section className="floating-panel data-panel records-panel">
          <PanelHeader title="Records" count={inspection.records.length.toString()} />
          <div className="list">
            {inspection.records.length
              ? inspection.records.map((entry, index) => (
                <RecordButton
                  key={`${entry.schemaId}:${entry.key}:${index}`}
                  record={entry}
                  index={index}
                  selected={index === selection.record}
                  onSelect={() => selectRaw({ kind: "record", index })}
                />
              ))
              : <div className="empty">No records</div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function useHuginnTerrainForces(fieldUrl: string) {
  const textureRef = useRef<TerrainTexture | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTerrainTexture(fieldUrl)
      .then((texture) => {
        if (!cancelled) {
          textureRef.current = texture;
        }
      })
      .catch(() => {
        textureRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [fieldUrl]);

  return useMemo(() => ({
    strength: 1.35,
    damping: 0.9,
    envelopeStrength: 0.03,
    emitNodeEnvelopes: true,
    sample: (x: number, y: number, context: TerrainForceContext): TerrainForceSample => {
      const texture = textureRef.current;
      const bounds = context.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
      const worldX = (x * context.viewportWidth - context.viewX) / Math.max(0.001, context.scale);
      const worldY = (y * context.viewportHeight - context.viewY) / Math.max(0.001, context.scale);
      const side = Math.max(1, Math.max(bounds.width, bounds.height));
      const uvX = (worldX - (bounds.x + bounds.width * 0.5 - side * 0.5)) / side;
      const uvY = (worldY - (bounds.y + bounds.height * 0.5 - side * 0.5)) / side;
      if (!texture) {
        const dx = uvX - 0.5;
        const dy = uvY - 0.5;
        const radius = Math.max(0.001, Math.hypot(dx, dy));
        return {
          flowX: -dy / radius * 0.35,
          flowY: dx / radius * 0.35,
          strength: Math.max(0, 1 - radius * 2),
          curvature: 0.25,
        };
      }
      return sampleTerrainTexture(texture, uvX, uvY);
    },
  }), []);
}

function loadTerrainTexture(url: string): Promise<TerrainTexture> {
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
    .then(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Canvas 2D context unavailable.");
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return {
        width: canvas.width,
        height: canvas.height,
        rgba: context.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    });
}

function sampleTerrainTexture(texture: TerrainTexture, x: number, y: number): TerrainForceSample {
  const sx = Math.max(0, Math.min(texture.width - 1, Math.floor(x * texture.width)));
  const sy = Math.max(0, Math.min(texture.height - 1, Math.floor(y * texture.height)));
  const index = (sy * texture.width + sx) * 4;
  return {
    flowX: texture.rgba[index] / 255 * 2 - 1,
    flowY: texture.rgba[index + 1] / 255 * 2 - 1,
    curvature: texture.rgba[index + 2] / 255,
    strength: texture.rgba[index + 3] / 255,
  };
}

function PanelHeader({ title, count }: { title: string; count: string }) {
  return (
    <header>
      <h2>{title}</h2>
      <span>{count}</span>
    </header>
  );
}

function ExpandedNodePanel({
  catalogEntry,
  expandedValue,
  inspection,
  record,
}: {
  catalogEntry: InspectedCatalogEntry | undefined;
  expandedValue: { path: string; value: unknown } | undefined;
  inspection: CultCacheInspection;
  record: InspectedRecord | undefined;
}) {
  const title = expandedValue?.path ?? record?.key ?? catalogEntry?.schemaName ?? inspection.filePath;
  const payloadValue = expandedValue?.value ?? record?.payloadPreview;
  return (
    <article className="expanded-content">
      <div className="expanded-kicker">{expandedValue ? "Payload Value" : "CultCache Node"}</div>
      <header className="expanded-header">
        <h1>{title}</h1>
        <div className="expanded-chips">
          <span>{inspection.format}</span>
          {record ? <span>{record.schemaName}</span> : <span>{inspection.records.length} records</span>}
          {expandedValue
            ? <span>{valueStatus(expandedValue.value)}</span>
            : record ? <span>{record.payloadBytes} bytes</span> : <span>{inspection.catalog.length} schemas</span>}
        </div>
      </header>
      <section className="expanded-summary">
        {expandedValue && record ? (
          <p>{expandedValue.path} inside {record.key}.</p>
        ) : record ? (
          <>
            <p>{record.schemaName} record stored at {record.storedAt}.</p>
            {record.payloadDecodeError ? <div className="error">{record.payloadDecodeError}</div> : null}
          </>
        ) : (
          <p>{inspection.filePath} contains a schema catalog and persisted MessagePack record set.</p>
        )}
      </section>
      {payloadValue !== undefined ? (
        <section className="expanded-payload">
          <h2>Payload</h2>
          <PayloadCode value={payloadValue} />
        </section>
      ) : null}
      <section className="expanded-article">
        <div>
          <h2>Record Metadata</h2>
          {record ? <RecordFacts record={record} /> : <div className="empty">Select a record node to inspect payload data.</div>}
        </div>
        <div>
          <h2>Schema Entry</h2>
          {catalogEntry ? <CatalogDetail entry={catalogEntry} /> : <div className="empty">Select a schema node to inspect catalog data.</div>}
        </div>
      </section>
      <footer className="expanded-footer">
        Record {record ? inspection.records.indexOf(record) + 1 : "-"} of {inspection.records.length}
      </footer>
    </article>
  );
}

function RecordButton({
  record,
  index,
  selected,
  onSelect,
}: {
  record: InspectedRecord;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className="row" type="button" data-record={index} aria-selected={selected} onClick={onSelect}>
      <strong>{record.key}</strong>
      <span>{record.schemaName} - {record.payloadBytes} bytes</span>
    </button>
  );
}

function RecordFacts({ record }: { record: InspectedRecord }) {
  return (
    <Facts rows={[
      ["Key", record.key],
      ["Schema", record.schemaName],
      ["Schema ID", record.schemaId],
      ["Stored", record.storedAt],
      ["Payload", `${record.payloadBytes} bytes`],
    ]} />
  );
}

function PayloadCode({ value }: { value: unknown }) {
  return (
    <pre className="payload-code">{JSON.stringify(value, null, 2)}</pre>
  );
}

function CatalogDetail({ entry }: { entry: InspectedCatalogEntry }) {
  return (
    <>
      <Facts rows={[
        ["Schema", entry.schemaName],
        ["Version", entry.schemaVersion],
        ["Schema ID", entry.schemaId],
        ["Hash", entry.contentHash],
        ["Compatible", entry.compatibleSchemaIds.join(", ")],
      ]} />
      <pre>{JSON.stringify({
        members: entry.members,
        canonicalSchemaJson: parseJson(entry.canonicalSchemaJson),
      }, null, 2)}</pre>
    </>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl>
      {rows.map(([name, value]) => (
        <div className="fact-row" key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function buildGraphProjection(inspection: CultCacheInspection): GraphProjection {
  const dataflowNodes: EpiphanyGraphNode[] = [];
  const dataflowEdges: EpiphanyGraphEdge[] = [];
  const recordNodeIds: string[] = [];
  const nodeSelections = new Map<string, RawSelection>();
  const edgeSelections = new Map<string, RawSelection>();
  const budget = {
    remainingValueNodes: MAX_EXPANDED_VALUE_NODES,
    truncatedValueNodes: 0,
  };
  const architectureNodes: EpiphanyGraphNode[] = [
    {
      id: "store",
      title: ".cc Store",
      purpose: `${inspection.format} file with ${inspection.records.length} record(s) and ${inspection.catalog.length} schema catalog entr${inspection.catalog.length === 1 ? "y" : "ies"}.`,
      mechanism: inspection.filePath,
      status: "source",
    },
    {
      id: "catalog",
      title: "Schema Catalog",
      purpose: "Maps persisted schema ids to schema names, versions, compatible ids, and slot metadata.",
      status: `${inspection.catalog.length} schemas`,
    },
    {
      id: "records",
      title: "Records",
      purpose: "Persisted document entries carrying key, schema id, timestamp, and raw MessagePack payload bytes.",
      status: `${inspection.records.length} records`,
    },
  ];
  const architectureEdges: EpiphanyGraphEdge[] = [
    {
      id: "store-catalog",
      source_id: "store",
      target_id: "catalog",
      kind: "contains",
      label: "schema catalog",
    },
    {
      id: "store-records",
      source_id: "store",
      target_id: "records",
      kind: "contains",
      label: "record set",
    },
  ];

  dataflowNodes.push({
    id: "store",
    title: ".cc Store",
    purpose: `Payload cloud for ${inspection.format} snapshot.`,
    mechanism: inspection.filePath,
    status: `${inspection.fileSizeBytes} bytes`,
  });
  inspection.records.forEach((record, recordIndex) => {
    const currentRecordNodeId = recordNodeId(record, recordIndex);
    const recordSelection: RawSelection = { kind: "record", index: recordIndex };
    const perRecordBudget = {
      remainingValueNodes: Math.max(24, Math.floor(MAX_EXPANDED_VALUE_NODES / Math.max(1, inspection.records.length))),
      truncatedValueNodes: 0,
    };
    recordNodeIds[recordIndex] = currentRecordNodeId;
    nodeSelections.set(currentRecordNodeId, recordSelection);
    dataflowNodes.push({
      id: currentRecordNodeId,
      title: record.key,
      purpose: valuePurpose(record.payloadPreview),
      mechanism: record.schemaName,
      status: `${record.payloadBytes} bytes`,
    });
    const recordEdgeId = edgeId("store", currentRecordNodeId, "contains");
    edgeSelections.set(recordEdgeId, recordSelection);
    dataflowEdges.push({
      id: recordEdgeId,
      source_id: "store",
      target_id: currentRecordNodeId,
      kind: "contains",
      label: "record",
    });
    appendValueTree({
      nodes: dataflowNodes,
      edges: dataflowEdges,
      nodeSelections,
      edgeSelections,
      recordIndex,
      parentId: currentRecordNodeId,
      value: record.payloadPreview,
      path: "payload",
      depth: 0,
      budget: perRecordBudget,
    });
    budget.truncatedValueNodes += perRecordBudget.truncatedValueNodes;
  });

  return {
    state: {
      architecture: { nodes: architectureNodes, edges: architectureEdges },
      dataflow: { nodes: dataflowNodes, edges: dataflowEdges },
      links: [],
    },
    recordNodeIds,
    nodeSelections,
    edgeSelections,
    truncatedValueNodes: budget.truncatedValueNodes,
  };
}

function appendValueTree({
  nodes,
  edges,
  nodeSelections,
  edgeSelections,
  recordIndex,
  parentId,
  value,
  path,
  depth,
  budget,
}: {
  nodes: EpiphanyGraphNode[];
  edges: EpiphanyGraphEdge[];
  nodeSelections: Map<string, RawSelection>;
  edgeSelections: Map<string, RawSelection>;
  recordIndex: number;
  parentId: string;
  value: unknown;
  path: string;
  depth: number;
  budget: { remainingValueNodes: number; truncatedValueNodes: number };
}): void {
  if (depth > 5) {
    budget.truncatedValueNodes += countExpandableChildren(value);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (!takeValueNodeBudget(budget, item)) {
        return;
      }
      const childPath = `${path}[${index}]`;
      const childId = nodeId("value", `${parentId}:${childPath}`);
      const rawSelection: RawSelection = { kind: "value", recordIndex, path: childPath, value: item };
      nodeSelections.set(childId, rawSelection);
      nodes.push(valueNode(childId, `[${index}]`, item, childPath));
      const edge = valueEdge(parentId, childId, "slot", index.toString());
      edgeSelections.set(edge.id!, rawSelection);
      edges.push(edge);
      appendValueTree({ nodes, edges, nodeSelections, edgeSelections, recordIndex, parentId: childId, value: item, path: childPath, depth: depth + 1, budget });
    });
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!takeValueNodeBudget(budget, item)) {
        continue;
      }
      const childPath = `${path}.${key}`;
      const childId = nodeId("value", `${parentId}:${childPath}`);
      const rawSelection: RawSelection = { kind: "value", recordIndex, path: childPath, value: item };
      nodeSelections.set(childId, rawSelection);
      nodes.push(valueNode(childId, key, item, childPath));
      const edge = valueEdge(parentId, childId, "field", key);
      edgeSelections.set(edge.id!, rawSelection);
      edges.push(edge);
      appendValueTree({ nodes, edges, nodeSelections, edgeSelections, recordIndex, parentId: childId, value: item, path: childPath, depth: depth + 1, budget });
    }
  }
}

function takeValueNodeBudget(
  budget: { remainingValueNodes: number; truncatedValueNodes: number },
  value: unknown,
): boolean {
  if (budget.remainingValueNodes <= 0) {
    budget.truncatedValueNodes += 1 + countExpandableChildren(value);
    return false;
  }

  budget.remainingValueNodes -= 1;
  return true;
}

function countExpandableChildren(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length;
  }
  return 0;
}

function valueNode(id: string, title: string, value: unknown, path: string): EpiphanyGraphNode {
  return {
    id,
    title: valueTitle(title, value),
    purpose: valuePurpose(value),
    mechanism: path,
    status: valueStatus(value),
  };
}

function valueTitle(title: string, value: unknown): string {
  if (Array.isArray(value) || isPlainObject(value)) {
    return title;
  }
  if (value === null) {
    return `${title}: null`;
  }
  const rendered = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const compact = rendered.length > 72 ? `${rendered.slice(0, 69)}...` : rendered;
  return `${title}: ${compact}`;
}

function recordNodeId(record: InspectedRecord, index: number): string {
  return nodeId("record", `${record.schemaId}:${record.key}:${index}`);
}

function valueEdge(sourceId: string, targetId: string, kind: string, label: string): EpiphanyGraphEdge {
  return {
    id: edgeId(sourceId, targetId, kind),
    source_id: sourceId,
    target_id: targetId,
    kind,
    label,
  };
}

function valuePurpose(value: unknown): string {
  if (Array.isArray(value)) {
    return `Array with ${value.length} item(s).`;
  }
  if (isPlainObject(value)) {
    return `Object with ${Object.keys(value).length} field(s).`;
  }
  if (value === null) {
    return "Null payload value.";
  }
  return JSON.stringify(value) ?? String(value);
}

function valueStatus(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (isPlainObject(value)) {
    return "object";
  }
  return typeof value;
}

function emptyGraphProjection(): GraphProjection {
  return {
    state: {
      architecture: { nodes: [], edges: [] },
      dataflow: { nodes: [], edges: [] },
      links: [],
    },
    recordNodeIds: [],
    nodeSelections: new Map(),
    edgeSelections: new Map(),
    truncatedValueNodes: 0,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function nodeId(prefix: string, value: string): string {
  return `${prefix}:${value.replace(/[^a-zA-Z0-9:_-]/g, "_")}`;
}

function edgeId(sourceId: string, targetId: string, kind: string): string {
  return `${sourceId}->${targetId}:${kind}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
