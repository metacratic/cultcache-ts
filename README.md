# CultCacheTS

`CultCacheTS` is the TypeScript port of the useful part of GameCult's `CultCache` idea: consumer code talks to typed documents, while a polymorphism-aware persistence layer deals with schemas, routing, and MessagePack.

This is not trying to cosplay as an ORM. It is for cases where you want:

- one cache API for heterogeneous document types
- runtime schema validation on load and write
- MessagePack-backed persistence
- backing-store routing instead of every script pawing raw files directly

## What It Does

- registers document types with Zod schemas
- stores heterogeneous documents behind a `type` discriminator
- persists them through pluggable backing stores
- ships with a hardened single-file MessagePack backing store

## What It Does Not Pretend To Do

- cross-process distributed consensus
- magical schema migrations
- every C# `CultCache` feature on day one

If multiple processes write the same backing file, use an external lock or a higher-order coordinator. The single-file store is atomic and process-local queue-safe, not a tiny database pretending it invented physics.

## Example

```ts
import { z } from "zod";
import {
  CultCache,
  SingleFileMessagePackBackingStore,
  defineDocumentType,
} from "cultcache-ts";

const settingsDocument = defineDocumentType({
  type: "settings",
  schema: z.object({
    theme: z.string(),
    retries: z.number().int().nonnegative(),
  }),
});

const cache = new CultCache();
cache.registerDocumentType(settingsDocument);
cache.addBackingStore(new SingleFileMessagePackBackingStore("cache.msgpack"));

await cache.pullAllBackingStores();

await cache.put(settingsDocument, "app", {
  theme: "ash",
  retries: 3,
});

const settings = cache.getRequired(settingsDocument, "app");
```

## Current Scope

- `CultCache`
- `SingleFileMessagePackBackingStore`
- typed document definitions via `defineDocumentType`

That is enough for consumers to stop writing their own sad little JSON-file bureaucracies and get back to the interesting part.
