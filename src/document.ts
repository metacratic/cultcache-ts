import type {
  AnyCultCacheDocumentDefinition,
  CultCacheDocumentDefinition,
  CultCacheDocumentRegistry,
  CultCacheSchema,
} from "./types";

export function defineDocumentType<TSchema extends CultCacheSchema>(
  definition: CultCacheDocumentDefinition<TSchema>,
): CultCacheDocumentDefinition<TSchema> {
  if (!definition.type || definition.type.trim().length === 0) {
    throw new Error("CultCache document types must declare a non-empty type.");
  }

  for (const [fieldName, fieldValue] of [
    ["schemaId", definition.schemaId],
    ["schemaName", definition.schemaName],
    ["schemaVersion", definition.schemaVersion],
    ["contentHash", definition.contentHash],
    ["canonicalSchemaJson", definition.canonicalSchemaJson],
  ] as const) {
    if (fieldValue !== undefined && fieldValue.trim().length === 0) {
      throw new Error(`CultCache document type "${definition.type}" declares an empty ${fieldName}.`);
    }
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

  if (definition.members) {
    const seenSlots = new Set<number>();
    for (const member of definition.members) {
      if (!Number.isInteger(member.slot) || member.slot < 0) {
        throw new Error(`CultCache document type "${definition.type}" declares an invalid schema member slot.`);
      }
      if (seenSlots.has(member.slot)) {
        throw new Error(`CultCache document type "${definition.type}" declares duplicate schema member slot ${member.slot}.`);
      }
      seenSlots.add(member.slot);
      if (!member.memberName || member.memberName.trim().length === 0) {
        throw new Error(`CultCache document type "${definition.type}" declares a schema member with an empty name.`);
      }
      if (!member.typeName || member.typeName.trim().length === 0) {
        throw new Error(`CultCache document type "${definition.type}" declares schema member "${member.memberName}" with an empty type.`);
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
