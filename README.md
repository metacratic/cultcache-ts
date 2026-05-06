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
- each persisted envelope stores:
  - `type`
  - `key`
  - raw MessagePack `payload` bytes
  - `storedAt`
- payload bytes only decode through the registered document definition for that `type`
- name and index maps live in the cache, not in the backing store
- global documents are treated as a singleton per type
- backing stores are adapters, not the public data model

That keeps the polymorphic boundary tight without making callers write boilerplate by candlelight.

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

## Security Model

`CultCacheTS` should never deserialize arbitrary persisted payloads into arbitrary runtime shapes.

It only accepts persisted envelopes whose `type` discriminator resolves to a registered document definition on the cache instance. Unknown types fail immediately. Known types decode through the registered formatter and schema for that type only.

That is the TypeScript version of the original CultCache trick:

- closed discriminator set
- explicit registration
- typed formatter path
- no runtime type-name roulette

## Persistence Model

`SingleFileMessagePackBackingStore` is the first concrete store.

- it writes atomic snapshots
- it queues local writes so one process does not step on its own shoelaces
- it persists raw MessagePack payload bytes inside MessagePack envelopes

It is a control-plane store, not a tiny god. If multiple processes hammer the same file, you still need a coordinator or an external lock instead of prayer.
