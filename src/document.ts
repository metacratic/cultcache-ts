import type { ZodType } from "zod";

import type { CultCacheDocumentDefinition } from "./types";

export function defineDocumentType<TSchema extends ZodType>(
  definition: CultCacheDocumentDefinition<TSchema>,
): CultCacheDocumentDefinition<TSchema> {
  if (!definition.type || definition.type.trim().length === 0) {
    throw new Error("CultCache document types must declare a non-empty type.");
  }

  return definition;
}
