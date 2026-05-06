import type { ZodType } from "zod";

import type { AnyCultCacheDocumentDefinition, CultCacheDocumentDefinition, CultCacheDocumentRegistry } from "./types";

export function defineDocumentType<TSchema extends ZodType>(
  definition: CultCacheDocumentDefinition<TSchema>,
): CultCacheDocumentDefinition<TSchema> {
  if (!definition.type || definition.type.trim().length === 0) {
    throw new Error("CultCache document types must declare a non-empty type.");
  }

  if (definition.name !== undefined && typeof definition.name !== "string" && typeof definition.name !== "function") {
    throw new Error(`CultCache document type "${definition.type}" declares an invalid name accessor.`);
  }

  if (Array.isArray(definition.indexes)) {
    const seen = new Set<string>();
    for (const index of definition.indexes) {
      if (!index.name || index.name.trim().length === 0) {
        throw new Error(`CultCache document type "${definition.type}" declares an index with an empty name.`);
      }
      if (seen.has(index.name)) {
        throw new Error(`CultCache document type "${definition.type}" declares duplicate index "${index.name}".`);
      }
      seen.add(index.name);
    }
  } else if (definition.indexes) {
    for (const name of Object.keys(definition.indexes)) {
      if (!name || name.trim().length === 0) {
        throw new Error(`CultCache document type "${definition.type}" declares an index with an empty name.`);
      }
    }
  }

  return Object.freeze({ ...definition });
}

export function defineDocumentRegistry<
  TDefinitions extends readonly AnyCultCacheDocumentDefinition[],
>(...definitions: TDefinitions): CultCacheDocumentRegistry<TDefinitions> {
  return Object.freeze({
    definitions: Object.freeze([...definitions]) as TDefinitions,
  });
}
