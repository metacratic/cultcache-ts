# CultCacheTS

`CultCacheTS` is the TypeScript port of the useful part of GameCult's `CultCache` idea: consumer code talks to typed domain documents, while a closed-world persistence layer deals with schemas, routing, name lookups, indexes, globals, and raw MessagePack bytes.

This is not an ORM in a fake mustache. It is for cases where you want:

- one cache API for heterogeneous domain documents
- typed reads and writes instead of every script massaging anonymous blobs
- lookup by type, logical key, name, and indexed property
- singleton-style global documents
- backing-store routing instead of every caller pawing raw files directly
- a persistence boundary that refuses unregistered polymorphic junk

## Current Shape

- document types are registered explicitly
- a document schema only needs a `parse(...)` function, so generated JSON-schema
  contracts can plug in directly without growing a second hand-written Zod body
- each persisted record stores:
  - `key`
  - `schemaId`
  - raw MessagePack `payload` bytes
  - `storedAt`
- the single-file store writes the CultCache v1 snapshot shape:
  - `formatVersion`
  - embedded schema catalog
  - record array
- payload bytes only decode through the registered document definition for that schema
- name and index maps live in the cache, not in the backing store
- global documents are treated as a singleton per type
- backing stores are adapters, not the public data model

That keeps the polymorphic boundary tight without making callers write boilerplate by candlelight.

## Huginn Inspector

CultCache files may use the `.cc` extension. The bytes are still the canonical
`cultcache.store.v1` MessagePack snapshot; the extension is the human handle, not
a second format.

Run the local inspector during development:

```sh
npm run dev:inspector
```

Build the Vite inspector bundle:

```sh
npm run build:inspector
```

Build the desktop package:

```sh
npm run dist:inspector
```

Release builds must carry a new semantic version before any deployable artifact
is produced. While the package is pre-1.0, breaking public behavior increments
the minor version, compatible fixes increment the patch version, and the
generated Huginn executable must use that package version in its filename.

Huginn is read-only. Drop a `.cc`, `.msgpack`, or `.mpack` file onto the window to
inspect the snapshot header, schema catalog, records, decoded MessagePack
payload previews, and an EpiphanyGraph cloud of the file's structured payload data
without registering application schemas.

Huginn's background field uses the graph node AABB as its single world-space
authority. The WebGPU particle pass keeps a million particle slots available,
intersects the current screen bounds with the artwork bounds, and assigns only
visible quadtree cells to those slots. Each visible cell is seeded with the
Aetheria Stardust `RandomFirst` hash and xorshift follow-up sequence, then each
particle pair trades opacity with sine/cosine phase while tracing a short
segment through the packed flow texture. The packed map uses `RG` for flow, `B`
for structure/curvature/detail pressure, and `A` for emission/field strength;
particle color comes from the source Huginn albedo at the starting UV so the
flow carries brushstrokes instead of repainting them at the final sample.
Zooming raises the live quadtree level; coarse cells fade down while finer cells
seeded from the same spatial lattice fade in around them, so detail density
rises without changing the field's identity.

## Example

```ts
import { z } from "zod";
import {
  CultCache,
  SingleFileMessagePackBackingStore,
  defineDocumentRegistry,
  defineDocumentType,
} from "cultcache-ts";

const itemDocument = defineDocumentType({
  type: "item",
  schemaId: "gamecult.item.v1",
  schemaName: "item",
  schemaVersion: "item.v1",
  schema: z.object({
    name: z.string(),
    category: z.string(),
    value: z.number().int(),
  }),
  name: "name",
  indexes: {
    category: "category",
  },
});

const settingsDocument = defineDocumentType({
  type: "settings",
  schema: z.object({
    theme: z.string(),
    retries: z.number().int().nonnegative(),
  }),
  global: true,
});

const registry = defineDocumentRegistry(itemDocument, settingsDocument);

const cache = CultCache.builder()
  .withRegistry(registry)
  .withGenericStore(new SingleFileMessagePackBackingStore("cache.msgpack"))
  .build();

await cache.pullAllBackingStores();

await cache.put(itemDocument, "item:potion", {
  name: "Potion",
  category: "Consumable",
  value: 50,
});

await cache.putGlobal(settingsDocument, {
  theme: "ash",
  retries: 3,
});

const potion = cache.getByName(itemDocument, "Potion");
const consumable = cache.getByIndex(itemDocument, "category", "Consumable");
const settings = cache.getRequiredGlobal(settingsDocument);
```

## Public Surface

- `defineDocumentType(...)`
- `defineDocumentRegistry(...)`
- `CultCache.builder()`
- `registerDocumentType(...)`
- `registerRegistry(...)`
- `registerNameLookup(...)`
- `registerIndex(...)`
- `addBackingStore(...)`
- `addGenericBackingStore(...)`
- `pullAllBackingStores()`
- `get(...)`
- `getRequired(...)`
- `getAll(...)`
- `getKeyByName(...)`
- `getByName(...)`
- `getKeyByIndex(...)`
- `getByIndex(...)`
- `getGlobal(...)`
- `getRequiredGlobal(...)`
- `put(...)`
- `putGlobal(...)`
- `update(...)`
- `updateGlobal(...)`
- `delete(...)`
- `deleteGlobal(...)`
- `snapshot()`
- `getEnvelope(...)`
- `getRequiredEnvelope(...)`
- `getGlobalEnvelope(...)`
- `putEnvelope(...)`

Document definitions may also carry persistence metadata for cross-language
stores: `schemaId`, `schemaName`, `schemaVersion`, `contentHash`,
`canonicalSchemaJson`, `compatibleSchemaIds`, and slot `members`.

## Name, Index, and Global Semantics

`name` and `indexes` can be declared on the document definition:

```ts
const playerDocument = defineDocumentType({
  type: "player",
  schema: playerSchema,
  name: "displayName",
  indexes: {
    faction: "faction",
    email: "email",
  },
});
```

You can also register them later if you feel like changing the machine after boot:

```ts
cache.registerNameLookup(playerDocument, "displayName");
cache.registerIndex(playerDocument, "faction", "faction");
```

Global documents are singleton-style per type:

```ts
await cache.putGlobal(settingsDocument, { theme: "ash", retries: 3 });
const settings = cache.getRequiredGlobal(settingsDocument);
```

If persisted state contains two globals for the same type, `pullAllBackingStores()` fails closed instead of pretending the contradiction is charming.

## Typed Formatters

Each document definition can provide a custom formatter:

```ts
const combatLogDocument = defineDocumentType({
  type: "combat-log",
  schema: combatLogSchema,
  formatter: {
    encode(value) {
      return myFastBinaryEncoder(value);
    },
    decode(payload) {
      return myFastBinaryDecoder(payload);
    },
  },
});
```

If you do not supply one, `CultCacheTS` uses MessagePack plus Zod validation by default.

Zod is no longer mandatory. Any schema object with a `parse(...)` function will
do, which means generated Ajv-backed JSON-schema contracts can feed the cache
directly as long as they expose the same parse surface.

The important boundary is this:

- payload bytes are persisted as bytes
- decoding goes through the registered formatter for that document type
- the decoded value is still validated against the declared schema

So callers get typed values, and the persistence layer does not become an open polymorphic sewer.

## Raw Envelope Fast Path

For bit-compatible neighbors such as CultNet peers that already share the same
formatter contract, `CultCacheTS` can now move the persisted envelope directly:

- `getEnvelope(...)` / `getRequiredEnvelope(...)` export the canonical
  MessagePack payload bytes for a typed document
- `putEnvelope(...)` ingests that envelope into another cache instance without
  re-encoding the payload first

Raw envelopes may carry `schemaId` and catalog metadata. Domain callers should
not need that sludge. Replication, migration tooling, and wire-compatibility
tests do.

That still is not magic shared memory. The cache decodes once so lookups and
typed reads stay honest. But it stops doing the stupid part where identical
MessagePack payload bytes get decoded into a generic value, then re-encoded
into the same bytes again just to cross the room.

## Security Model

`CultCacheTS` should never deserialize arbitrary persisted payloads into arbitrary runtime shapes.

It only accepts persisted records whose `schemaId` or legacy `type` discriminator resolves to a registered document definition on the cache instance. Unknown schemas fail immediately. Known schemas decode through the registered formatter and schema only.

That is the TypeScript version of the original CultCache trick:

- closed discriminator set
- explicit registration
- typed formatter path
- no runtime type-name roulette

## Persistence Model

`SingleFileMessagePackBackingStore` is the first concrete store.

- it writes atomic CultCache v1 MessagePack snapshots
- the top-level MessagePack value is `[formatVersion, schemaCatalog, records]`
- each record is `[key, schemaId, storedAt, payload]`
- each catalog entry is `[schemaId, schemaName, schemaVersion, contentHash, canonicalSchemaJson, compatibleSchemaIds, members]`
- it still reads the older TS/Rust-style envelope array and rewrites repaired legacy payloads as v1 snapshots
- it queues local writes so one process does not step on its own shoelaces
- it persists raw MessagePack payload bytes inside schema-addressed records

It is a control-plane store, not a tiny god. If multiple processes hammer the same file, you still need a coordinator or an external lock instead of prayer.
