import { EpiphanyGraphViewer, type EpiphanyGraphEdge, type EpiphanyGraphNode, type EpiphanyGraphsState } from "@epiphanygraph/epiphany-graph-viewer";
import { createRoot } from "react-dom/client";
import { useMemo, useState, type DragEvent } from "react";

import { inspectCultCacheBytes, type CultCacheInspection, type InspectedCatalogEntry, type InspectedRecord } from "../../src/cult-cache-inspector";
import "./styles.css";

type Selection = {
  record: number;
  catalog: number;
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing inspector app root.");
}

createRoot(app).render(<HuginApp />);

function HuginApp() {
  const [inspection, setInspection] = useState<CultCacheInspection | undefined>();
  const [selection, setSelection] = useState<Selection>({ record: 0, catalog: 0 });
  const [errorMessage, setErrorMessage] = useState("");
  const [dragging, setDragging] = useState(false);

  const graphState = useMemo(
    () => inspection ? buildGraphState(inspection) : emptyGraphState(),
    [inspection],
  );

  async function inspectFile(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setInspection(inspectCultCacheBytes(file.name, bytes, file.size));
      setSelection({ record: 0, catalog: 0 });
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
      <section className="sidebar">
        <div className="brand">
          <img src="/hugin-64.png" alt="" width="64" height="64" />
          <div>
            <h1>Hugin</h1>
            <p>CultCache state inspection for <code>.cc</code> files.</p>
          </div>
        </div>
        <label className="dropzone">
          <input
            type="file"
            accept=".cc,.msgpack,.mpack,application/octet-stream"
            onChange={(event) => {
              const file = event.currentTarget.files?.item(0);
              if (file) {
                void inspectFile(file);
              }
            }}
          />
          <span className="drop-title">Drop CultCache file</span>
          <span className="drop-copy">or choose one from disk</span>
        </label>
        {errorMessage ? <div className="error">{errorMessage}</div> : null}
        {inspection ? <Summary inspection={inspection} /> : <EmptySummary />}
      </section>
      <section className="content">
        {inspection
          ? <InspectionView inspection={inspection} graphState={graphState} selection={selection} setSelection={setSelection} />
          : <NoFile />}
      </section>
    </main>
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
      <img src="/hugin.png" alt="" />
      <h2>No state loaded</h2>
      <p>Drag a CultCache <code>.cc</code> store into the window to inspect the snapshot header, schema catalog, records, and decoded MessagePack payloads.</p>
    </div>
  );
}

function InspectionView({
  inspection,
  graphState,
  selection,
  setSelection,
}: {
  inspection: CultCacheInspection;
  graphState: EpiphanyGraphsState;
  selection: Selection;
  setSelection: (selection: Selection) => void;
}) {
  const record = inspection.records[selection.record];
  const catalogEntry = inspection.catalog[selection.catalog];

  return (
    <div className="inspector-stack">
      <section className="graph-panel">
        <EpiphanyGraphViewer
          state={graphState}
          initialGraph="dataflow"
          title="CultCache Structure"
          style={{ minHeight: 620 }}
        />
      </section>
      <div className="columns">
        <section className="panel">
          <header><h2>Records</h2><span>{inspection.records.length}</span></header>
          <div className="list">
            {inspection.records.length
              ? inspection.records.map((entry, index) => (
                <RecordButton
                  key={`${entry.schemaId}:${entry.key}`}
                  record={entry}
                  index={index}
                  selected={index === selection.record}
                  onSelect={() => setSelection({ ...selection, record: index })}
                />
              ))
              : <div className="empty">No records</div>}
          </div>
        </section>
        <section className="panel detail">
          <header><h2>Record Detail</h2><span>{inspection.filePath}</span></header>
          {record ? <RecordDetail record={record} /> : <div className="empty">No record selected</div>}
        </section>
      </div>
      <div className="columns bottom">
        <section className="panel">
          <header><h2>Schema Catalog</h2><span>{inspection.catalog.length}</span></header>
          <div className="list">
            {inspection.catalog.length
              ? inspection.catalog.map((entry, index) => (
                <CatalogButton
                  key={entry.schemaId}
                  entry={entry}
                  index={index}
                  selected={index === selection.catalog}
                  onSelect={() => setSelection({ ...selection, catalog: index })}
                />
              ))
              : <div className="empty">No schema catalog</div>}
          </div>
        </section>
        <section className="panel detail">
          <header><h2>Catalog Entry</h2><span>{catalogEntry?.schemaVersion ?? ""}</span></header>
          {catalogEntry ? <CatalogDetail entry={catalogEntry} /> : <div className="empty">No catalog entry selected</div>}
        </section>
      </div>
    </div>
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
      <span>{record.schemaName} · {record.payloadBytes} bytes</span>
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

function buildGraphState(inspection: CultCacheInspection): EpiphanyGraphsState {
  const dataflowNodes: EpiphanyGraphNode[] = [];
  const dataflowEdges: EpiphanyGraphEdge[] = [];
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

  for (const entry of inspection.catalog) {
    const schemaNodeId = nodeId("schema", entry.schemaId);
    dataflowNodes.push({
      id: schemaNodeId,
      title: entry.schemaName,
      purpose: `Schema ${entry.schemaVersion} with ${entry.members.length} declared slot(s).`,
      mechanism: entry.contentHash,
      status: "schema",
    });
    dataflowEdges.push({
      id: edgeId("store", schemaNodeId, "catalogs"),
      source_id: "store",
      target_id: schemaNodeId,
      kind: "catalogs",
      label: "catalog",
    });
  }

  inspection.records.forEach((record, recordIndex) => {
    const recordNodeId = nodeId("record", `${record.schemaId}:${record.key}:${recordIndex}`);
    const schemaNodeId = nodeId("schema", record.schemaId);
    dataflowNodes.push({
      id: recordNodeId,
      title: record.key,
      purpose: `Document record for ${record.schemaName}.`,
      mechanism: `${record.payloadBytes} payload bytes stored at ${record.storedAt}`,
      status: "record",
    });
    dataflowEdges.push({
      id: edgeId("store", recordNodeId, "contains"),
      source_id: "store",
      target_id: recordNodeId,
      kind: "contains",
      label: "record",
    });
    if (dataflowNodes.some((node) => node.id === schemaNodeId)) {
      dataflowEdges.push({
        id: edgeId(recordNodeId, schemaNodeId, "uses-schema"),
        source_id: recordNodeId,
        target_id: schemaNodeId,
        kind: "uses-schema",
        label: "schema",
      });
    }

    appendValueTree({
      nodes: dataflowNodes,
      edges: dataflowEdges,
      parentId: recordNodeId,
      value: record.payloadPreview,
      path: "payload",
      depth: 0,
    });
  });

  return {
    architecture: { nodes: architectureNodes, edges: architectureEdges },
    dataflow: { nodes: dataflowNodes, edges: dataflowEdges },
    links: [],
  };
}

function appendValueTree({
  nodes,
  edges,
  parentId,
  value,
  path,
  depth,
}: {
  nodes: EpiphanyGraphNode[];
  edges: EpiphanyGraphEdge[];
  parentId: string;
  value: unknown;
  path: string;
  depth: number;
}): void {
  if (depth > 5) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const childPath = `${path}[${index}]`;
      const childId = nodeId("value", `${parentId}:${childPath}`);
      nodes.push(valueNode(childId, `[${index}]`, item, childPath));
      edges.push(valueEdge(parentId, childId, "slot", index.toString()));
      appendValueTree({ nodes, edges, parentId: childId, value: item, path: childPath, depth: depth + 1 });
    });
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      const childId = nodeId("value", `${parentId}:${childPath}`);
      nodes.push(valueNode(childId, key, item, childPath));
      edges.push(valueEdge(parentId, childId, "field", key));
      appendValueTree({ nodes, edges, parentId: childId, value: item, path: childPath, depth: depth + 1 });
    }
  }
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

function emptyGraphState(): EpiphanyGraphsState {
  return {
    architecture: { nodes: [], edges: [] },
    dataflow: { nodes: [], edges: [] },
    links: [],
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
