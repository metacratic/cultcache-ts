"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CultCache = void 0;
class CultCache {
    #definitions = new Map();
    #entries = new Map();
    #stores = [];
    registerDocumentType(definition) {
        const existing = this.#definitions.get(definition.type);
        if (existing && existing !== definition) {
            throw new Error(`CultCache already has a different definition registered for type "${definition.type}".`);
        }
        this.#definitions.set(definition.type, definition);
        return definition;
    }
    addBackingStore(store, ...types) {
        this.#stores.push({
            store,
            types: [...new Set(types)],
        });
    }
    async pullAllBackingStores() {
        this.#entries.clear();
        for (const registration of this.#stores) {
            const entries = await registration.store.pullAll();
            for (const entry of entries) {
                const definition = this.#definitions.get(entry.type);
                if (!definition) {
                    throw new Error(`No schema is registered for persisted document type "${entry.type}".`);
                }
                const parsed = definition.schema.parse(entry.payload);
                this.#entries.set(this.#entryId(entry.type, entry.key), {
                    ...entry,
                    payload: parsed,
                });
            }
        }
    }
    get(definition, key) {
        this.#requireDefinition(definition);
        const entry = this.#entries.get(this.#entryId(definition.type, key));
        return entry ? entry.payload : undefined;
    }
    getRequired(definition, key) {
        const value = this.get(definition, key);
        if (value === undefined) {
            throw new Error(`CultCache has no "${definition.type}" document at key "${key}".`);
        }
        return value;
    }
    getAll(definition) {
        this.#requireDefinition(definition);
        const values = [];
        for (const entry of this.#entries.values()) {
            if (entry.type === definition.type) {
                values.push(entry.payload);
            }
        }
        return values;
    }
    async put(definition, key, value) {
        this.#requireDefinition(definition);
        const parsed = definition.schema.parse(value);
        const entry = {
            key,
            type: definition.type,
            payload: parsed,
            storedAt: new Date().toISOString(),
        };
        const route = this.#resolveRoute(definition.type);
        if (!route.primary) {
            throw new Error(`No backing store is registered for document type "${definition.type}".`);
        }
        await route.primary.push(entry);
        await Promise.all(route.mirrors.map(async (mirror) => mirror.push(entry)));
        this.#entries.set(this.#entryId(definition.type, key), entry);
        return parsed;
    }
    async update(definition, key, updater) {
        const current = this.get(definition, key);
        return this.put(definition, key, updater(current));
    }
    async delete(definition, key) {
        this.#requireDefinition(definition);
        const entry = this.#entries.get(this.#entryId(definition.type, key));
        if (!entry) {
            return false;
        }
        const route = this.#resolveRoute(definition.type);
        if (!route.primary) {
            throw new Error(`No backing store is registered for document type "${definition.type}".`);
        }
        await route.primary.delete(entry);
        await Promise.all(route.mirrors.map(async (mirror) => mirror.delete(entry)));
        this.#entries.delete(this.#entryId(definition.type, key));
        return true;
    }
    snapshot() {
        return [...this.#entries.values()].map((entry) => structuredClone(entry));
    }
    #requireDefinition(definition) {
        const registered = this.#definitions.get(definition.type);
        if (!registered || registered !== definition) {
            throw new Error(`CultCache document type "${definition.type}" is not registered on this cache instance.`);
        }
        return definition;
    }
    #resolveRoute(type) {
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
    #entryId(type, key) {
        return `${type}::${key}`;
    }
}
exports.CultCache = CultCache;
