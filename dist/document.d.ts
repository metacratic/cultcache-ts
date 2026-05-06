import type { ZodType } from "zod";
import type { AnyCultCacheDocumentDefinition, CultCacheDocumentDefinition, CultCacheDocumentRegistry } from "./types";
export declare function defineDocumentType<TSchema extends ZodType>(definition: CultCacheDocumentDefinition<TSchema>): CultCacheDocumentDefinition<TSchema>;
export declare function defineDocumentRegistry<TDefinitions extends readonly AnyCultCacheDocumentDefinition[]>(...definitions: TDefinitions): CultCacheDocumentRegistry<TDefinitions>;
//# sourceMappingURL=document.d.ts.map