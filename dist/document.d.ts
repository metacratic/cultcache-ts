import type { AnyCultCacheDocumentDefinition, CultCacheDocumentDefinition, CultCacheDocumentRegistry, CultCacheSchema } from "./types";
export declare function defineDocumentType<TSchema extends CultCacheSchema>(definition: CultCacheDocumentDefinition<TSchema>): CultCacheDocumentDefinition<TSchema>;
export declare function defineDocumentRegistry<TDefinitions extends readonly AnyCultCacheDocumentDefinition[]>(...definitions: TDefinitions): CultCacheDocumentRegistry<TDefinitions>;
//# sourceMappingURL=document.d.ts.map