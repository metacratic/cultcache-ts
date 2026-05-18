import { EpiphanyGraphViewer, type EpiphanyGraphEdge, type EpiphanyGraphNode, type EpiphanyGraphsState, type ViewerSelection } from "@epiphanygraph/epiphany-graph-viewer";
import { createRoot } from "react-dom/client";
import { Component, useMemo, useState, type DragEvent, type ReactNode } from "react";

import { inspectCultCacheBytes, type CultCacheInspection, type InspectedCatalogEntry, type InspectedRecord } from "../../src/cult-cache-inspector";
import { HuginnFieldCanvas } from "./HuginnFieldCanvas";
import "./styles.css";

type Selection = {
  record: number;
  catalog: number;
};

type RawSelection =
  | { kind: "record"; index: number }
  | { kind: "catalog"; index: number };

type GraphProjection = {
  state: EpiphanyGraphsState;
  recordNodeIds: string[];
  catalogNodeIds: string[];
  nodeSelections: Map<string, RawSelection>;
  edgeSelections: Map<string, RawSelection>;
  truncatedValueNodes: number;
};

const MAX_EXPANDED_VALUE_NODES = 320;
const assetPath = (name: string) => `${import.meta.env.BASE_URL}${name}`;
const HUGINN_ART = {
  ground: assetPath("huginn-groundtruth-alpha.png"),
  curvature: assetPath("huginn-curvature.png"),
  flow: assetPath("huginn-flow.png"),
  normal: assetPath("huginn-normal.png"),
};

function HuginnField() {
  return (
    <HuginnFieldCanvas
      imageUrl={HUGINN_ART.ground}
      curvatureUrl={HUGINN_ART.curvature}
      flowUrl={HUGINN_ART.flow}
      normalUrl={HUGINN_ART.normal}
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
  const [selection, setSelection] = useState<Selection>({ record: 0, catalog: 0 });
  const [graphSelection, setGraphSelection] = useState<ViewerSelection | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [dragging, setDragging] = useState(false);

  const graphProjection = useMemo(
    () => inspection ? buildGraphProjection(inspection, selection.record) : emptyGraphProjection(),
    [inspection, selection.record],
  );

  async function inspectFile(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setInspection(inspectCultCacheBytes(file.name, bytes, file.size));
      setSelection({ record: 0, catalog: 0 });
      setGraphSelection({
        kind: "node",
        graphKey: "dataflow",
        nodeId: "store",
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
      <img src={HUGINN_ART.ground} alt="" />
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
  const record = inspection.records[selection.record];
  const catalogEntry = inspection.catalog[selection.catalog];
  const expandedNode = graphSelection?.kind === "node"
    ? {
        graphKey: graphSelection.graphKey,
        nodeId: graphSelection.nodeId,
        className: "huginn-expanded-node",
        ariaLabel: "Selected CultCache node",
        content: (
          <ExpandedNodePanel
            catalogEntry={catalogEntry}
            inspection={inspection}
            record={record}
            selection={selection}
          />
        ),
      }
    : undefined;
  const selectRaw = (next: RawSelection) => {
    if (next.kind === "record") {
      setSelection({ ...selection, record: next.index });
      setGraphSelection({
        kind: "node",
        graphKey: "dataflow",
        nodeId: graphProjection.recordNodeIds[next.index],
      });
      return;
    }

    setSelection({ ...selection, catalog: next.index });
    setGraphSelection({
      kind: "node",
      graphKey: "dataflow",
      nodeId: graphProjection.catalogNodeIds[next.index],
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

    setSelection(rawSelection.kind === "record"
      ? { ...selection, record: rawSelection.index }
      : { ...selection, catalog: rawSelection.index });
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
          overlayPanels
          showSidebar={false}
          focusSelection
          selectionFocusMode="preview"
          expandedNode={expandedNode}
          graphLabels={{ architecture: "File", dataflow: "Payload" }}
          style={{ minHeight: "100vh" }}
        />
        {graphProjection.truncatedValueNodes > 0 ? (
          <div className="graph-warning">
            Payload tree clipped after {MAX_EXPANDED_VALUE_NODES} value nodes; {graphProjection.truncatedValueNodes} deeper node(s) omitted from the graph. Raw payload detail remains below.
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
        <section className="floating-panel data-panel catalog-panel">
          <PanelHeader title="Schema Catalog" count={inspection.catalog.length.toString()} />
          <div className="list">
            {inspection.catalog.length
              ? inspection.catalog.map((entry, index) => (
                <CatalogButton
                  key={entry.schemaId}
                  entry={entry}
                  index={index}
                  selected={index === selection.catalog}
                  onSelect={() => selectRaw({ kind: "catalog", index })}
                />
              ))
              : <div className="empty">No schema catalog</div>}
          </div>
        </section>
        <section className="floating-panel detail-panel">
          <PanelHeader title="Selected Raw View" count={record?.key ?? catalogEntry?.schemaVersion ?? ""} />
          <div className="detail-tabs">
            <section>
              <h3>Record</h3>
              {record ? <RecordDetail record={record} /> : <div className="empty">No record selected</div>}
            </section>
            <section>
              <h3>Schema</h3>
              {catalogEntry ? <CatalogDetail entry={catalogEntry} /> : <div className="empty">No catalog entry selected</div>}
            </section>
          </div>
        </section>
      </div>
    </div>
  );
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
  inspection,
  record,
  selection,
}: {
  catalogEntry: InspectedCatalogEntry | undefined;
  inspection: CultCacheInspection;
  record: InspectedRecord | undefined;
  selection: Selection;
}) {
  return (
    <article className="expanded-content">
      <div className="expanded-kicker">CultCache Node</div>
      <header className="expanded-header">
        <h1>{record?.key ?? catalogEntry?.schemaName ?? inspection.filePath}</h1>
        <div className="expanded-chips">
          <span>{inspection.format}</span>
          <span>{inspection.records.length} records</span>
          <span>{inspection.catalog.length} schemas</span>
        </div>
      </header>
      <section className="expanded-summary">
        {record ? (
          <>
            <p>{record.schemaName} record stored at {record.storedAt} with {record.payloadBytes} payload bytes.</p>
            {record.payloadDecodeError ? <div className="error">{record.payloadDecodeError}</div> : null}
          </>
        ) : (
          <p>{inspection.filePath} contains a schema catalog and persisted MessagePack record set.</p>
        )}
      </section>
      <section className="expanded-article">
        <div>
          <h2>Record Payload</h2>
          {record ? <RecordDetail record={record} /> : <div className="empty">Select a record node to inspect payload data.</div>}
        </div>
        <div>
          <h2>Schema Entry</h2>
          {catalogEntry ? <CatalogDetail entry={catalogEntry} /> : <div className="empty">Select a schema node to inspect catalog data.</div>}
        </div>
      </section>
      <footer className="expanded-footer">
        Raw selection: record {selection.record + 1}, schema {selection.catalog + 1}
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

function CatalogButton({
  entry,
  index,
  selected,
  onSelect,
}: {
  entry: InspectedCatalogEntry;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className="row" type="button" data-catalog={index} aria-selected={selected} onClick={onSelect}>
      <strong>{entry.schemaName}</strong>
      <span>{entry.schemaId}</span>
    </button>
  );
}

function RecordDetail({ record }: { record: InspectedRecord }) {
  return (
    <>
      <Facts rows={[
        ["Key", record.key],
        ["Schema", record.schemaName],
        ["Schema ID", record.schemaId],
        ["Stored", record.storedAt],
        ["Payload", `${record.payloadBytes} bytes`],
      ]} />
      {record.payloadDecodeError ? <div className="error">{record.payloadDecodeError}</div> : null}
      <pre>{JSON.stringify(record.payloadPreview, null, 2)}</pre>
    </>
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

function buildGraphProjection(inspection: CultCacheInspection, expandedRecordIndex: number): GraphProjection {
  const dataflowNodes: EpiphanyGraphNode[] = [];
  const dataflowEdges: EpiphanyGraphEdge[] = [];
  const recordNodeIds: string[] = [];
  const catalogNodeIds: string[] = [];
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
    purpose: `Root ${inspection.format} snapshot.`,
    mechanism: inspection.filePath,
    status: `${inspection.fileSizeBytes} bytes`,
  });

  for (const [catalogIndex, entry] of inspection.catalog.entries()) {
    const schemaNodeId = nodeId("schema", entry.schemaId);
    catalogNodeIds[catalogIndex] = schemaNodeId;
    nodeSelections.set(schemaNodeId, { kind: "catalog", index: catalogIndex });
    dataflowNodes.push({
      id: schemaNodeId,
      title: entry.schemaName,
      purpose: `Schema ${entry.schemaVersion} with ${entry.members.length} declared slot(s).`,
      mechanism: entry.contentHash,
      status: "schema",
    });
    const catalogEdgeId = edgeId("store", schemaNodeId, "catalogs");
    edgeSelections.set(catalogEdgeId, { kind: "catalog", index: catalogIndex });
    dataflowEdges.push({
      id: catalogEdgeId,
      source_id: "store",
      target_id: schemaNodeId,
      kind: "catalogs",
      label: "catalog",
    });
  }

  inspection.records.forEach((record, recordIndex) => {
    const recordNodeId = nodeId("record", `${record.schemaId}:${record.key}:${recordIndex}`);
    const schemaNodeId = nodeId("schema", record.schemaId);
    recordNodeIds[recordIndex] = recordNodeId;
    nodeSelections.set(recordNodeId, { kind: "record", index: recordIndex });
    dataflowNodes.push({
      id: recordNodeId,
      title: record.key,
      purpose: `Document record for ${record.schemaName}.`,
      mechanism: `${record.payloadBytes} payload bytes stored at ${record.storedAt}`,
      status: "record",
    });
    const recordEdgeId = edgeId("store", recordNodeId, "contains");
    edgeSelections.set(recordEdgeId, { kind: "record", index: recordIndex });
    dataflowEdges.push({
      id: recordEdgeId,
      source_id: "store",
      target_id: recordNodeId,
      kind: "contains",
      label: "record",
    });
    if (dataflowNodes.some((node) => node.id === schemaNodeId)) {
      const schemaEdgeId = edgeId(recordNodeId, schemaNodeId, "uses-schema");
      edgeSelections.set(schemaEdgeId, { kind: "record", index: recordIndex });
      dataflowEdges.push({
        id: schemaEdgeId,
        source_id: recordNodeId,
        target_id: schemaNodeId,
        kind: "uses-schema",
        label: "schema",
      });
    }

    if (recordIndex === expandedRecordIndex) {
      appendValueTree({
        nodes: dataflowNodes,
        edges: dataflowEdges,
        nodeSelections,
        edgeSelections,
        rawSelection: { kind: "record", index: recordIndex },
        parentId: recordNodeId,
        value: record.payloadPreview,
        path: "payload",
        depth: 0,
        budget,
      });
    }
  });

  return {
    state: {
      architecture: { nodes: architectureNodes, edges: architectureEdges },
      dataflow: { nodes: dataflowNodes, edges: dataflowEdges },
      links: [],
    },
    recordNodeIds,
    catalogNodeIds,
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
  rawSelection,
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
  rawSelection: RawSelection;
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
      nodeSelections.set(childId, rawSelection);
      nodes.push(valueNode(childId, `[${index}]`, item, childPath));
      const edge = valueEdge(parentId, childId, "slot", index.toString());
      edgeSelections.set(edge.id!, rawSelection);
      edges.push(edge);
      appendValueTree({ nodes, edges, nodeSelections, edgeSelections, rawSelection, parentId: childId, value: item, path: childPath, depth: depth + 1, budget });
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
      nodeSelections.set(childId, rawSelection);
      nodes.push(valueNode(childId, key, item, childPath));
      const edge = valueEdge(parentId, childId, "field", key);
      edgeSelections.set(edge.id!, rawSelection);
      edges.push(edge);
      appendValueTree({ nodes, edges, nodeSelections, edgeSelections, rawSelection, parentId: childId, value: item, path: childPath, depth: depth + 1, budget });
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
    title,
    purpose: valuePurpose(value),
    mechanism: path,
    status: valueStatus(value),
  };
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
    catalogNodeIds: [],
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
