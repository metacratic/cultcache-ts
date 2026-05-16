import { inspectCultCacheBytes, type CultCacheInspection, type InspectedCatalogEntry, type InspectedRecord } from "../../src/cult-cache-inspector";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing inspector app root.");
}
const appRoot = app;

type Selection = {
  record: number;
  catalog: number;
};

let inspection: CultCacheInspection | undefined;
let selection: Selection = { record: 0, catalog: 0 };
let errorMessage = "";
let dragging = false;

appRoot.addEventListener("dragover", (event) => {
  event.preventDefault();
  dragging = true;
  render();
});

appRoot.addEventListener("dragleave", (event) => {
  if (event.target === appRoot) {
    dragging = false;
    render();
  }
});

appRoot.addEventListener("drop", (event) => {
  event.preventDefault();
  dragging = false;
  const file = event.dataTransfer?.files.item(0);
  if (file) {
    void inspectFile(file);
  }
});

render();

function render(): void {
  appRoot.innerHTML = `
    <main class="workspace ${dragging ? "is-dragging" : ""}">
      <section class="sidebar">
        <div class="brand">
          <h1>CultCache Inspector</h1>
          <p>Drop a <code>.cc</code> file and read the wire format without registering app schemas.</p>
        </div>
        <label class="dropzone">
          <input id="file-input" type="file" accept=".cc,.msgpack,.mpack,application/octet-stream" />
          <span class="drop-title">Drop CultCache file</span>
          <span class="drop-copy">or choose one from disk</span>
        </label>
        ${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ""}
        ${inspection ? renderSummary(inspection) : renderEmptyState()}
      </section>
      <section class="content">
        ${inspection ? renderInspection(inspection, selection) : renderNoFile()}
      </section>
    </main>
  `;

  appRoot.querySelector<HTMLInputElement>("#file-input")?.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.item(0);
    if (file) {
      void inspectFile(file);
    }
  });

  appRoot.querySelectorAll<HTMLButtonElement>("[data-record]").forEach((button) => {
    button.addEventListener("click", () => {
      selection = { ...selection, record: Number(button.dataset.record) };
      render();
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>("[data-catalog]").forEach((button) => {
    button.addEventListener("click", () => {
      selection = { ...selection, catalog: Number(button.dataset.catalog) };
      render();
    });
  });
}

async function inspectFile(file: File): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    inspection = inspectCultCacheBytes(file.name, bytes, file.size);
    selection = { record: 0, catalog: 0 };
    errorMessage = "";
  } catch (error) {
    inspection = undefined;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  render();
}

function renderSummary(model: CultCacheInspection): string {
  return `
    <div class="summary">
      ${metric("Format", model.format)}
      ${metric("Records", model.records.length.toString())}
      ${metric("Schemas", model.catalog.length.toString())}
      ${metric("Bytes", model.fileSizeBytes.toString())}
    </div>
  `;
}

function renderEmptyState(): string {
  return `
    <div class="summary">
      ${metric("Format", ".cc")}
      ${metric("Mode", "Read-only")}
      ${metric("Payload", "MessagePack")}
      ${metric("Runtime", "Vite")}
    </div>
  `;
}

function renderNoFile(): string {
  return `
    <div class="hero">
      <h2>No file loaded</h2>
      <p>Drag a CultCache <code>.cc</code> store into the window. The inspector shows the snapshot header, schema catalog, records, and decoded payload slot arrays.</p>
    </div>
  `;
}

function renderInspection(model: CultCacheInspection, current: Selection): string {
  const record = model.records[current.record];
  const catalogEntry = model.catalog[current.catalog];
  return `
    <div class="columns">
      <section class="panel">
        <header><h2>Records</h2><span>${model.records.length}</span></header>
        <div class="list">
          ${model.records.map((entry, index) => renderRecordButton(entry, index, index === current.record)).join("") || `<div class="empty">No records</div>`}
        </div>
      </section>
      <section class="panel detail">
        <header><h2>Record Detail</h2><span>${escapeHtml(model.filePath)}</span></header>
        ${record ? renderRecordDetail(record) : `<div class="empty">No record selected</div>`}
      </section>
    </div>
    <div class="columns bottom">
      <section class="panel">
        <header><h2>Schema Catalog</h2><span>${model.catalog.length}</span></header>
        <div class="list">
          ${model.catalog.map((entry, index) => renderCatalogButton(entry, index, index === current.catalog)).join("") || `<div class="empty">No schema catalog</div>`}
        </div>
      </section>
      <section class="panel detail">
        <header><h2>Catalog Entry</h2><span>${catalogEntry ? escapeHtml(catalogEntry.schemaVersion) : ""}</span></header>
        ${catalogEntry ? renderCatalogDetail(catalogEntry) : `<div class="empty">No catalog entry selected</div>`}
      </section>
    </div>
  `;
}

function renderRecordButton(record: InspectedRecord, index: number, selected: boolean): string {
  return `
    <button class="row" type="button" data-record="${index}" aria-selected="${selected}">
      <strong>${escapeHtml(record.key)}</strong>
      <span>${escapeHtml(record.schemaName)} · ${record.payloadBytes} bytes</span>
    </button>
  `;
}

function renderCatalogButton(entry: InspectedCatalogEntry, index: number, selected: boolean): string {
  return `
    <button class="row" type="button" data-catalog="${index}" aria-selected="${selected}">
      <strong>${escapeHtml(entry.schemaName)}</strong>
      <span>${escapeHtml(entry.schemaId)}</span>
    </button>
  `;
}

function renderRecordDetail(record: InspectedRecord): string {
  return `
    ${facts([
      ["Key", record.key],
      ["Schema", record.schemaName],
      ["Schema ID", record.schemaId],
      ["Stored", record.storedAt],
      ["Payload", `${record.payloadBytes} bytes`],
    ])}
    ${record.payloadDecodeError ? `<div class="error">${escapeHtml(record.payloadDecodeError)}</div>` : ""}
    <pre>${escapeHtml(JSON.stringify(record.payloadPreview, null, 2))}</pre>
  `;
}

function renderCatalogDetail(entry: InspectedCatalogEntry): string {
  return `
    ${facts([
      ["Schema", entry.schemaName],
      ["Version", entry.schemaVersion],
      ["Schema ID", entry.schemaId],
      ["Hash", entry.contentHash],
      ["Compatible", entry.compatibleSchemaIds.join(", ")],
    ])}
    <pre>${escapeHtml(JSON.stringify({
      members: entry.members,
      canonicalSchemaJson: parseJson(entry.canonicalSchemaJson),
    }, null, 2))}</pre>
  `;
}

function facts(rows: Array<[string, string]>): string {
  return `<dl>${rows.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
