import { decode, encode } from "@msgpack/msgpack";

import type {
  AnyCultCacheDocumentDefinition,
  CacheBackingStore,
  CultCacheDocumentAccessor,
  CultCacheDocumentDefinition,
  CultCacheDocumentFormatter,
  CultCacheDocumentRegistry,
  CultCacheDocumentValue,
  CultCacheEnvelope,
  CultCacheSchemaCatalogEntry,
  CultCacheStoreRegistration,
} from "./types";

type StoreRoute = {
  primary?: CacheBackingStore;
  mirrors: CacheBackingStore[];
};

type RegisteredDefinition = {
  readonly definition: AnyCultCacheDocumentDefinition;
  readonly global: boolean;
  readonly formatter: CultCacheDocumentFormatter<unknown>;
  readonly catalogEntry: CultCacheSchemaCatalogEntry;
  nameAccessor?: (value: unknown) => string | undefined;
  readonly indexAccessors: Map<string, (value: unknown) => string | undefined>;
};

type HydratedEntry = CultCacheEnvelope & {
  value: unknown;
};

type BackingStoreTypeReference = string | AnyCultCacheDocumentDefinition;
type AccessorInput = string | ((value: any) => unknown);

export class CultCacheBuilder {
  readonly #cache = new CultCache();

  withDocumentType<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition): this {
    this.#cache.registerDocumentType(definition);
    return this;
  }

  withRegistry(
    registry:
      | CultCacheDocumentRegistry
      | Iterable<AnyCultCacheDocumentDefinition>,
  ): this {
    this.#cache.registerRegistry(registry);
    return this;
  }

  withBackingStore(
    store: CacheBackingStore,
    ...types: BackingStoreTypeReference[]
  ): this {
    this.#cache.addBackingStore(store, ...types);
    return this;
  }

  withGenericStore(store: CacheBackingStore): this {
    this.#cache.addGenericBackingStore(store);
    return this;
  }

  build(): CultCache {
    return this.#cache;
  }
}

export class CultCache {
  static readonly GLOBAL_KEY = "__global__";

  readonly #definitions = new Map<string, RegisteredDefinition>();
  readonly #schemaIdDefinitions = new Map<string, RegisteredDefinition>();
  readonly #entries = new Map<string, HydratedEntry>();
  readonly #typeEntryIds = new Map<string, Set<string>>();
  readonly #nameToKeyMaps = new Map<string, Map<string, string>>();
  readonly #indexToKeyMaps = new Map<string, Map<string, string>>();
  readonly #globalKeys = new Map<string, string>();
  readonly #stores: CultCacheStoreRegistration[] = [];

  static builder(): CultCacheBuilder {
    return new CultCacheBuilder();
  }

  registerDocumentType<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
  ): TDefinition {
    const existing = this.#definitions.get(definition.type);
    if (existing && existing.definition !== definition) {
      throw new Error(`CultCache already has a different definition registered for type "${definition.type}".`);
    }

    const registered = existing ?? {
      definition,
      global: definition.global === true,
      formatter: this.#createFormatter(definition),
      catalogEntry: this.#createCatalogEntry(definition),
      nameAccessor: undefined,
      indexAccessors: new Map<string, (value: unknown) => string | undefined>(),
    };

    registered.nameAccessor = definition.name
      ? this.#compileAccessor(definition.type, "name", definition.name)
      : undefined;
    registered.indexAccessors.clear();
    for (const [indexName, accessor] of this.#enumerateDefinitionIndexes(definition)) {
      registered.indexAccessors.set(
        indexName,
        this.#compileAccessor(definition.type, `index "${indexName}"`, accessor),
      );
    }

    this.#definitions.set(definition.type, registered);
    for (const schemaId of registered.catalogEntry.compatibleSchemaIds ?? [registered.catalogEntry.schemaId]) {
      const existingBySchema = this.#schemaIdDefinitions.get(schemaId);
      if (existingBySchema && existingBySchema !== registered) {
        throw new Error(`CultCache schema id "${schemaId}" is already registered for type "${existingBySchema.definition.type}".`);
      }
      this.#schemaIdDefinitions.set(schemaId, registered);
    }
    this.#rebuildDefinitionLookups(registered);
    return definition;
  }

  registerRegistry(
    registry:
      | CultCacheDocumentRegistry
      | Iterable<AnyCultCacheDocumentDefinition>,
  ): this {
    const definitions = Symbol.iterator in Object(registry) && !("definitions" in Object(registry))
      ? registry as Iterable<AnyCultCacheDocumentDefinition>
      : (registry as CultCacheDocumentRegistry).definitions;

    for (const definition of definitions) {
      this.registerDocumentType(definition);
    }

    return this;
  }

  registerNameLookup<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    accessor: CultCacheDocumentAccessor<CultCacheDocumentValue<TDefinition>>,
  ): TDefinition {
    const registered = this.#requireDefinition(definition);
    registered.nameAccessor = this.#compileAccessor(definition.type, "name", accessor);
    this.#rebuildNameLookup(registered);
    return definition;
  }

  registerIndex<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    indexName: string,
    accessor: CultCacheDocumentAccessor<CultCacheDocumentValue<TDefinition>>,
  ): TDefinition {
    if (!indexName || indexName.trim().length === 0) {
      throw new Error(`CultCache index names for type "${definition.type}" must be non-empty.`);
    }

    const registered = this.#requireDefinition(definition);
    registered.indexAccessors.set(
      indexName,
      this.#compileAccessor(definition.type, `index "${indexName}"`, accessor),
    );
    this.#rebuildIndexLookup(registered, indexName);
    return definition;
  }

  addBackingStore(
    store: CacheBackingStore,
    ...types: BackingStoreTypeReference[]
  ): void {
    this.#stores.push({
      store,
      types: [...new Set(types.map((value) => (typeof value === "string" ? value : value.type)))],
    });
  }

  addGenericBackingStore(store: CacheBackingStore): void {
    this.addBackingStore(store);
  }

  async pullAllBackingStores(): Promise<void> {
    this.#resetHydratedState();

    for (const registration of this.#stores) {
      const entries = await registration.store.pullAll();

      for (const entry of entries) {
        const registered = this.#resolveDefinitionForEnvelope(entry);
        if (!registered) {
          throw new Error(
            entry.schemaId
              ? `No schema is registered for persisted schema id "${entry.schemaId}".`
              : `No schema is registered for persisted document type "${entry.type}".`,
          );
        }

        const payload = this.#cloneBytes(entry.payload);
        const value = registered.formatter.decode(payload);
        this.#applyHydratedEntry(registered, {
          ...entry,
          payload,
        }, value, "pull");
      }
    }
  }

  get<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    key: string,
  ): CultCacheDocumentValue<TDefinition> | undefined {
    this.#requireDefinition(definition);
    const entry = this.#entries.get(this.#entryId(definition.type, key));
    return entry ? (entry.value as CultCacheDocumentValue<TDefinition>) : undefined;
  }

  getRequired<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    key: string,
  ): CultCacheDocumentValue<TDefinition> {
    const value = this.get(definition, key);
    if (value === undefined) {
      throw new Error(`CultCache has no "${definition.type}" document at key "${key}".`);
    }

    return value;
  }

  getEnvelope<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    key: string,
  ): CultCacheEnvelope | undefined {
    this.#requireDefinition(definition);
    const entry = this.#entries.get(this.#entryId(definition.type, key));
    return entry ? this.#toEnvelope(entry) : undefined;
  }

  getRequiredEnvelope<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    key: string,
  ): CultCacheEnvelope {
    const entry = this.getEnvelope(definition, key);
    if (!entry) {
      throw new Error(`CultCache has no "${definition.type}" envelope at key "${key}".`);
    }

    return entry;
  }

  getGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
  ): CultCacheDocumentValue<TDefinition> | undefined {
    const registered = this.#requireDefinition(definition);
    if (!registered.global) {
      throw new Error(`CultCache document type "${definition.type}" is not marked as global.`);
    }

    const globalKey = this.#globalKeys.get(definition.type);
    return globalKey ? this.get(definition, globalKey) : undefined;
  }

  getRequiredGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
  ): CultCacheDocumentValue<TDefinition> {
    const value = this.getGlobal(definition);
    if (value === undefined) {
      throw new Error(`CultCache has no global "${definition.type}" document.`);
    }

    return value;
  }

  getGlobalEnvelope<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
  ): CultCacheEnvelope | undefined {
    const registered = this.#requireDefinition(definition);
    if (!registered.global) {
      throw new Error(`CultCache document type "${definition.type}" is not marked as global.`);
    }

    const globalKey = this.#globalKeys.get(definition.type);
    return globalKey ? this.getEnvelope(definition, globalKey) : undefined;
  }

  getAll<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
  ): CultCacheDocumentValue<TDefinition>[] {
    this.#requireDefinition(definition);
    const values: CultCacheDocumentValue<TDefinition>[] = [];
    const entryIds = this.#typeEntryIds.get(definition.type);

    if (!entryIds) {
      return values;
    }

    for (const entryId of entryIds) {
      const entry = this.#entries.get(entryId);
      if (entry) {
        values.push(entry.value as CultCacheDocumentValue<TDefinition>);
      }
    }

    return values;
  }

  getKeyByName<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    name: string,
  ): string | undefined {
    const registered = this.#requireDefinition(definition);
    if (!registered.nameAccessor) {
      return undefined;
    }

    return this.#nameToKeyMaps.get(definition.type)?.get(name);
  }

  getIdByName<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    name: string,
  ): string | undefined {
    return this.getKeyByName(definition, name);
  }

  getByName<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    name: string,
  ): CultCacheDocumentValue<TDefinition> | undefined {
    const key = this.getKeyByName(definition, name);
    return key ? this.get(definition, key) : undefined;
  }

  getKeyByIndex<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    indexName: string,
    value: string,
  ): string | undefined {
    this.#requireDefinition(definition);
    return this.#indexToKeyMaps.get(this.#indexId(definition.type, indexName))?.get(value);
  }

  getIdByIndex<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    indexName: string,
    value: string,
  ): string | undefined {
    return this.getKeyByIndex(definition, indexName, value);
  }

  getByIndex<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    indexName: string,
    value: string,
  ): CultCacheDocumentValue<TDefinition> | undefined {
    const key = this.getKeyByIndex(definition, indexName, value);
    return key ? this.get(definition, key) : undefined;
  }

  async put<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    key: string,
    value: CultCacheDocumentValue<TDefinition>,
  ): Promise<CultCacheDocumentValue<TDefinition>> {
    const registered = this.#requireDefinition(definition);
    const payload = registered.formatter.encode(value);
    const parsed = registered.formatter.decode(payload) as CultCacheDocumentValue<TDefinition>;
    const entry: CultCacheEnvelope = {
      key,
      type: definition.type,
      payload: this.#cloneBytes(payload),
      storedAt: new Date().toISOString(),
      schemaId: registered.catalogEntry.schemaId,
      catalogEntry: registered.catalogEntry,
    };

    const route = this.#resolveRoute(definition.type);
    if (!route.primary) {
      throw new Error(`No backing store is registered for document type "${definition.type}".`);
    }

    if (registered.global) {
      const existingGlobalKey = this.#globalKeys.get(definition.type);
      if (existingGlobalKey && existingGlobalKey !== key) {
        await this.delete(definition, existingGlobalKey);
      }
    }

    await route.primary.push(entry);
    await Promise.all(route.mirrors.map(async (mirror) => mirror.push(entry)));
    this.#applyHydratedEntry(registered, entry, parsed, "put");
    return parsed;
  }

  async putEnvelope<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    envelope: CultCacheEnvelope,
  ): Promise<CultCacheDocumentValue<TDefinition>> {
    const registered = this.#requireDefinition(definition);
    if (envelope.type !== definition.type) {
      throw new Error(
        `CultCache envelope type "${envelope.type}" does not match definition "${definition.type}".`,
      );
    }
    if (!envelope.key || envelope.key.trim().length === 0) {
      throw new Error(`CultCache envelope key for type "${definition.type}" must be non-empty.`);
    }
    if (!envelope.storedAt || envelope.storedAt.trim().length === 0) {
      throw new Error(`CultCache envelope storedAt for type "${definition.type}" must be non-empty.`);
    }

    const payload = this.#cloneBytes(envelope.payload);
    const parsed = registered.formatter.decode(payload) as CultCacheDocumentValue<TDefinition>;
    const entry: CultCacheEnvelope = {
      key: envelope.key,
      type: envelope.type,
      payload,
      storedAt: envelope.storedAt,
      schemaId: envelope.schemaId ?? registered.catalogEntry.schemaId,
      catalogEntry: envelope.catalogEntry ?? registered.catalogEntry,
    };

    const route = this.#resolveRoute(definition.type);
    if (!route.primary) {
      throw new Error(`No backing store is registered for document type "${definition.type}".`);
    }

    if (registered.global) {
      const existingGlobalKey = this.#globalKeys.get(definition.type);
      if (existingGlobalKey && existingGlobalKey !== entry.key) {
        await this.delete(definition, existingGlobalKey);
      }
    }

    await route.primary.push(entry);
    await Promise.all(route.mirrors.map(async (mirror) => mirror.push(entry)));
    this.#applyHydratedEntry(registered, entry, parsed, "put");
    return parsed;
  }

  async putGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    value: CultCacheDocumentValue<TDefinition>,
  ): Promise<CultCacheDocumentValue<TDefinition>> {
    const registered = this.#requireDefinition(definition);
    if (!registered.global) {
      throw new Error(`CultCache document type "${definition.type}" is not marked as global.`);
    }

    return this.put(definition, CultCache.GLOBAL_KEY, value);
  }

  async update<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    key: string,
    updater: (
      current: CultCacheDocumentValue<TDefinition> | undefined,
    ) => CultCacheDocumentValue<TDefinition>,
  ): Promise<CultCacheDocumentValue<TDefinition>> {
    const current = this.get(definition, key);
    return this.put(definition, key, updater(current));
  }

  async updateGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    updater: (
      current: CultCacheDocumentValue<TDefinition> | undefined,
    ) => CultCacheDocumentValue<TDefinition>,
  ): Promise<CultCacheDocumentValue<TDefinition>> {
    const current = this.getGlobal(definition);
    return this.putGlobal(definition, updater(current));
  }

  async delete<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
    key: string,
  ): Promise<boolean> {
    const registered = this.#requireDefinition(definition);
    const entry = this.#entries.get(this.#entryId(definition.type, key));
    if (!entry) {
      return false;
    }

    const route = this.#resolveRoute(definition.type);
    if (!route.primary) {
      throw new Error(`No backing store is registered for document type "${definition.type}".`);
    }

    const envelope = this.#toEnvelope(entry);
    await route.primary.delete(envelope);
    await Promise.all(route.mirrors.map(async (mirror) => mirror.delete(envelope)));
    this.#removeHydratedEntry(registered, entry);
    return true;
  }

  async deleteGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
  ): Promise<boolean> {
    const registered = this.#requireDefinition(definition);
    if (!registered.global) {
      throw new Error(`CultCache document type "${definition.type}" is not marked as global.`);
    }

    const globalKey = this.#globalKeys.get(definition.type);
    return globalKey ? this.delete(definition, globalKey) : false;
  }

  snapshot(): CultCacheEnvelope[] {
    return [...this.#entries.values()].map((entry) => this.#toEnvelope(entry));
  }

  #createFormatter(definition: AnyCultCacheDocumentDefinition): CultCacheDocumentFormatter<unknown> {
    const userFormatter = definition.formatter ?? {
      encode: (value: unknown) => encode(value),
      decode: (payload: Uint8Array) => decode(payload),
    };

    return {
      encode: (value: unknown) => {
        const parsed = definition.schema.parse(value);
        return this.#cloneBytes(userFormatter.encode(parsed));
      },
      decode: (payload: Uint8Array) => {
        const decoded = userFormatter.decode(this.#cloneBytes(payload));
        return definition.schema.parse(decoded);
      },
    };
  }

  #createCatalogEntry(definition: AnyCultCacheDocumentDefinition): CultCacheSchemaCatalogEntry {
    const schemaName = definition.schemaName ?? definition.type;
    const schemaVersion = definition.schemaVersion ?? `${schemaName}.v1`;
    const canonicalSchemaJson = definition.canonicalSchemaJson ?? JSON.stringify({
      schemaName,
      schemaVersion,
      members: [...(definition.members ?? [])]
        .sort((left, right) => left.slot - right.slot)
        .map((member) => ({
          slot: member.slot,
          name: member.memberName,
          type: member.typeName,
          isReference: member.isReference === true,
          many: member.isMany === true,
          targetSchemaName: member.targetSchemaName ?? null,
          indexAlias: member.indexAlias ?? null,
          isName: member.isName === true,
        })),
    });
    const schemaId = definition.schemaId ?? schemaName;
    const compatibleSchemaIds = [
      ...new Set([schemaId, ...(definition.compatibleSchemaIds ?? [])]),
    ];

    return {
      schemaId,
      schemaName,
      schemaVersion,
      contentHash: definition.contentHash ?? schemaId,
      canonicalSchemaJson,
      compatibleSchemaIds,
      members: [...(definition.members ?? [])]
        .sort((left, right) => left.slot - right.slot)
        .map((member) => ({
          slot: member.slot,
          memberName: member.memberName,
          typeName: member.typeName,
          isReference: member.isReference === true,
          isMany: member.isMany === true,
          targetSchemaName: member.targetSchemaName ?? null,
          isName: member.isName === true,
          indexAlias: member.indexAlias ?? null,
        })),
    };
  }

  #enumerateDefinitionIndexes(
    definition: AnyCultCacheDocumentDefinition,
  ): Array<[string, AccessorInput]> {
    if (!definition.indexes) {
      return [];
    }

    if (Array.isArray(definition.indexes)) {
      return definition.indexes.map((index) => [index.name, index.accessor as AccessorInput]);
    }

    return Object.entries(definition.indexes) as Array<[string, AccessorInput]>;
  }

  #compileAccessor(
    type: string,
    label: string,
    accessor: AccessorInput,
  ): (value: unknown) => string | undefined {
    if (typeof accessor === "function") {
      return (value: unknown) => this.#normalizeIndexValue(type, label, accessor(value));
    }

    return (value: unknown) => {
      if (value === null || typeof value !== "object") {
        return undefined;
      }

      const fieldValue = (value as Record<string, unknown>)[accessor];
      return this.#normalizeIndexValue(type, `${label} field "${accessor}"`, fieldValue);
    };
  }

  #normalizeIndexValue(
    type: string,
    label: string,
    value: unknown,
  ): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    switch (typeof value) {
      case "string":
        return value;
      case "number":
      case "boolean":
      case "bigint":
        return String(value);
      default:
        throw new Error(`CultCache ${label} accessor for type "${type}" produced a non-scalar value.`);
    }
  }

  #requireDefinition<TDefinition extends AnyCultCacheDocumentDefinition>(
    definition: TDefinition,
  ): RegisteredDefinition {
    const registered = this.#definitions.get(definition.type);
    if (!registered || registered.definition !== definition) {
      throw new Error(`CultCache document type "${definition.type}" is not registered on this cache instance.`);
    }

    return registered;
  }

  #resolveDefinitionForEnvelope(entry: CultCacheEnvelope): RegisteredDefinition | undefined {
    if (entry.schemaId) {
      return this.#schemaIdDefinitions.get(entry.schemaId) ?? this.#definitions.get(entry.type);
    }

    return this.#definitions.get(entry.type);
  }

  #resolveRoute(type: string): StoreRoute {
    const typeSpecific = this.#stores.filter((registration) => registration.types.includes(type));
    if (typeSpecific.length > 0) {
      return {
        primary: typeSpecific[0]?.store,
        mirrors: typeSpecific.slice(1).map((registration) => registration.store),
      };
    }

    const generic = this.#stores.filter((registration) => registration.types.length === 0);
    return {
      primary: generic[0]?.store,
      mirrors: generic.slice(1).map((registration) => registration.store),
    };
  }

  #applyHydratedEntry(
    registered: RegisteredDefinition,
    entry: CultCacheEnvelope,
    value: unknown,
    source: "pull" | "put",
  ): void {
    const entryId = this.#entryId(entry.type, entry.key);
    const existing = this.#entries.get(entryId);
    if (existing) {
      this.#removeHydratedEntry(registered, existing);
    }

    if (registered.global) {
      const currentGlobalKey = this.#globalKeys.get(entry.type);
      if (currentGlobalKey && currentGlobalKey !== entry.key) {
        throw new Error(
          source === "pull"
            ? `CultCache global document type "${entry.type}" has multiple persisted entries.`
            : `CultCache global document type "${entry.type}" already has a different key "${currentGlobalKey}".`,
        );
      }
    }

    const hydrated: HydratedEntry = {
      ...entry,
      payload: this.#cloneBytes(entry.payload),
      schemaId: entry.schemaId ?? registered.catalogEntry.schemaId,
      catalogEntry: entry.catalogEntry ?? registered.catalogEntry,
      value,
    };
    this.#entries.set(entryId, hydrated);
    this.#getOrCreateTypeEntrySet(entry.type).add(entryId);

    if (registered.global) {
      this.#globalKeys.set(entry.type, entry.key);
    }

    if (registered.nameAccessor) {
      const name = registered.nameAccessor(value);
      if (name !== undefined) {
        this.#getOrCreateNameMap(entry.type).set(name, entry.key);
      }
    }

    for (const [indexName, accessor] of registered.indexAccessors) {
      const indexValue = accessor(value);
      if (indexValue !== undefined) {
        this.#getOrCreateIndexMap(entry.type, indexName).set(indexValue, entry.key);
      }
    }
  }

  #removeHydratedEntry(
    registered: RegisteredDefinition,
    entry: HydratedEntry,
  ): void {
    const entryId = this.#entryId(entry.type, entry.key);
    this.#entries.delete(entryId);

    const typeEntryIds = this.#typeEntryIds.get(entry.type);
    if (typeEntryIds) {
      typeEntryIds.delete(entryId);
      if (typeEntryIds.size === 0) {
        this.#typeEntryIds.delete(entry.type);
      }
    }

    if (registered.global && this.#globalKeys.get(entry.type) === entry.key) {
      this.#globalKeys.delete(entry.type);
    }

    if (registered.nameAccessor) {
      const name = registered.nameAccessor(entry.value);
      if (name !== undefined) {
        this.#nameToKeyMaps.get(entry.type)?.delete(name);
      }
    }

    for (const [indexName, accessor] of registered.indexAccessors) {
      const value = accessor(entry.value);
      if (value !== undefined) {
        this.#indexToKeyMaps.get(this.#indexId(entry.type, indexName))?.delete(value);
      }
    }
  }

  #rebuildDefinitionLookups(registered: RegisteredDefinition): void {
    this.#rebuildNameLookup(registered);

    for (const indexName of registered.indexAccessors.keys()) {
      this.#rebuildIndexLookup(registered, indexName);
    }
  }

  #rebuildNameLookup(registered: RegisteredDefinition): void {
    this.#nameToKeyMaps.delete(registered.definition.type);

    if (!registered.nameAccessor) {
      return;
    }

    const map = this.#getOrCreateNameMap(registered.definition.type);
    for (const entry of this.#entriesForType(registered.definition.type)) {
      const name = registered.nameAccessor(entry.value);
      if (name !== undefined) {
        map.set(name, entry.key);
      }
    }
  }

  #rebuildIndexLookup(registered: RegisteredDefinition, indexName: string): void {
    const lookupId = this.#indexId(registered.definition.type, indexName);
    this.#indexToKeyMaps.delete(lookupId);

    const accessor = registered.indexAccessors.get(indexName);
    if (!accessor) {
      return;
    }

    const map = this.#getOrCreateIndexMap(registered.definition.type, indexName);
    for (const entry of this.#entriesForType(registered.definition.type)) {
      const value = accessor(entry.value);
      if (value !== undefined) {
        map.set(value, entry.key);
      }
    }
  }

  #entriesForType(type: string): HydratedEntry[] {
    const entryIds = this.#typeEntryIds.get(type);
    if (!entryIds) {
      return [];
    }

    const entries: HydratedEntry[] = [];
    for (const entryId of entryIds) {
      const entry = this.#entries.get(entryId);
      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  #getOrCreateTypeEntrySet(type: string): Set<string> {
    let set = this.#typeEntryIds.get(type);
    if (!set) {
      set = new Set<string>();
      this.#typeEntryIds.set(type, set);
    }
    return set;
  }

  #getOrCreateNameMap(type: string): Map<string, string> {
    let map = this.#nameToKeyMaps.get(type);
    if (!map) {
      map = new Map<string, string>();
      this.#nameToKeyMaps.set(type, map);
    }
    return map;
  }

  #getOrCreateIndexMap(type: string, indexName: string): Map<string, string> {
    const lookupId = this.#indexId(type, indexName);
    let map = this.#indexToKeyMaps.get(lookupId);
    if (!map) {
      map = new Map<string, string>();
      this.#indexToKeyMaps.set(lookupId, map);
    }
    return map;
  }

  #toEnvelope(entry: HydratedEntry): CultCacheEnvelope {
    return {
      key: entry.key,
      type: entry.type,
      payload: this.#cloneBytes(entry.payload),
      storedAt: entry.storedAt,
      schemaId: entry.schemaId,
      catalogEntry: entry.catalogEntry,
    };
  }

  #resetHydratedState(): void {
    this.#entries.clear();
    this.#typeEntryIds.clear();
    this.#nameToKeyMaps.clear();
    this.#indexToKeyMaps.clear();
    this.#globalKeys.clear();
  }

  #entryId(type: string, key: string): string {
    return `${type}::${key}`;
  }

  #indexId(type: string, indexName: string): string {
    return `${type}::${indexName}`;
  }

  #cloneBytes(payload: Uint8Array): Uint8Array {
    return new Uint8Array(payload);
  }
}
