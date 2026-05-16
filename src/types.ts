export type CultCacheIndexScalar = string | number | boolean | bigint;

export interface CultCacheSchema<TValue = unknown> {
  parse(input: unknown): TValue;
}

export type InferCultCacheSchemaValue<TSchema extends CultCacheSchema> =
  TSchema extends CultCacheSchema<infer TValue> ? TValue : never;

export type CultCacheDocumentFieldName<TValue> = TValue extends object ? Extract<keyof TValue, string> : never;

export type CultCacheDocumentAccessor<TValue> =
  | CultCacheDocumentFieldName<TValue>
  | ((value: TValue) => CultCacheIndexScalar | null | undefined);

export interface CultCacheDocumentFormatter<TValue> {
  encode(value: TValue): Uint8Array;
  decode(payload: Uint8Array): TValue;
}

export interface CultCacheSchemaCatalogMember {
  slot: number;
  memberName: string;
  typeName: string;
  isReference?: boolean;
  isMany?: boolean;
  targetSchemaName?: string | null;
  isName?: boolean;
  indexAlias?: string | null;
}

export interface CultCacheSchemaCatalogEntry {
  schemaId: string;
  schemaName: string;
  schemaVersion: string;
  contentHash: string;
  canonicalSchemaJson: string;
  compatibleSchemaIds?: readonly string[];
  members?: readonly CultCacheSchemaCatalogMember[];
}

export interface CultCacheDocumentIndexDefinition<TValue> {
  name: string;
  accessor: CultCacheDocumentAccessor<TValue>;
}

export interface CultCacheDocumentDefinition<TSchema extends CultCacheSchema = CultCacheSchema> {
  type: string;
  schema: TSchema;
  schemaId?: string;
  schemaName?: string;
  schemaVersion?: string;
  contentHash?: string;
  canonicalSchemaJson?: string;
  compatibleSchemaIds?: readonly string[];
  members?: readonly CultCacheSchemaCatalogMember[];
  global?: boolean;
  name?: CultCacheDocumentAccessor<InferCultCacheSchemaValue<TSchema>>;
  indexes?:
    | Readonly<Record<string, CultCacheDocumentAccessor<InferCultCacheSchemaValue<TSchema>>>>
    | readonly CultCacheDocumentIndexDefinition<InferCultCacheSchemaValue<TSchema>>[];
  formatter?: CultCacheDocumentFormatter<InferCultCacheSchemaValue<TSchema>>;
}

export type CultCacheDocumentValue<TDefinition extends CultCacheDocumentDefinition> = InferCultCacheSchemaValue<
  TDefinition["schema"]
>;

export type AnyCultCacheDocumentDefinition = CultCacheDocumentDefinition<any>;

export interface CultCacheDocumentRegistry<
  TDefinitions extends readonly AnyCultCacheDocumentDefinition[] = readonly AnyCultCacheDocumentDefinition[],
> {
  readonly definitions: TDefinitions;
}

export interface CultCacheEnvelope {
  key: string;
  type: string;
  payload: Uint8Array;
  storedAt: string;
  schemaId?: string;
  catalogEntry?: CultCacheSchemaCatalogEntry;
}

export interface PushAllOptions {
  soft?: boolean;
}

export interface CacheBackingStore {
  pullAll(): Promise<CultCacheEnvelope[]>;
  push(entry: CultCacheEnvelope): Promise<void>;
  delete(entry: CultCacheEnvelope): Promise<void>;
  pushAll?(entries: CultCacheEnvelope[], options?: PushAllOptions): Promise<void>;
}

export interface CultCacheStoreRegistration {
  store: CacheBackingStore;
  types: string[];
}
