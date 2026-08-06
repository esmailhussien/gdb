const REFERENCE_DATA_CACHE_PREFIX = '__formsView_refCache_';

export const REFERENCE_DATA_CHANGED_EVENT = 'reference-data-changed';

function normalizedProjectId(projectId) {
    return String(projectId || '').trim();
}

function defaultSessionStorage() {
    try {
        return globalThis.sessionStorage || null;
    } catch (_) {
        return null;
    }
}

function defaultEventTarget() {
    return globalThis.document || null;
}

function createDetailEvent(type, detail) {
    if (typeof CustomEvent === 'function') return new CustomEvent(type, { detail });
    const event = new Event(type);
    Object.defineProperty(event, 'detail', { value: detail, enumerable: true });
    return event;
}

export function referenceDataCacheKey(projectId) {
    const normalized = normalizedProjectId(projectId);
    return normalized ? `${REFERENCE_DATA_CACHE_PREFIX}${normalized}` : '';
}

export function createReferenceDataDictionary(records = []) {
    const dictionary = Object.create(null);

    for (const record of records || []) {
        const sourceLayer = String(record?.source_layer || '').trim();
        if (!sourceLayer) continue;
        if (!dictionary[sourceLayer]) dictionary[sourceLayer] = new Set();
        if (record?.properties && typeof record.properties === 'object') {
            Object.keys(record.properties).forEach(property => dictionary[sourceLayer].add(property));
        }
    }

    return dictionary;
}

export function readReferenceDataCache(projectId, storage = defaultSessionStorage()) {
    const key = referenceDataCacheKey(projectId);
    if (!key || !storage?.getItem) return null;

    try {
        const cached = storage.getItem(key);
        if (!cached) return null;
        const parsed = JSON.parse(cached);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

        const dictionary = Object.create(null);
        for (const [sourceLayer, properties] of Object.entries(parsed)) {
            if (!Array.isArray(properties)) return null;
            dictionary[sourceLayer] = new Set(properties);
        }
        return dictionary;
    } catch (_) {
        return null;
    }
}

export function writeReferenceDataCache(projectId, dictionary, storage = defaultSessionStorage()) {
    const key = referenceDataCacheKey(projectId);
    if (!key || !storage?.setItem) return false;

    try {
        const serializable = Object.create(null);
        for (const sourceLayer of Object.keys(dictionary || {})) {
            serializable[sourceLayer] = [...(dictionary[sourceLayer] || [])];
        }
        storage.setItem(key, JSON.stringify(serializable));
        return true;
    } catch (_) {
        return false;
    }
}

export function invalidateReferenceDataCache(projectId, options = {}) {
    const normalized = normalizedProjectId(projectId);
    const key = referenceDataCacheKey(normalized);
    if (!key) return false;

    const storage = options.storage === undefined ? defaultSessionStorage() : options.storage;
    const eventTarget = options.eventTarget === undefined ? defaultEventTarget() : options.eventTarget;

    try {
        storage?.removeItem?.(key);
    } catch (_) {
        // Cache eviction is best-effort; the change signal still allows a
        // mounted Forms view to reload directly from the database.
    }

    eventTarget?.dispatchEvent?.(createDetailEvent(REFERENCE_DATA_CHANGED_EVENT, {
        projectId: normalized,
        source: options.source || 'local'
    }));
    return true;
}

export function subscribeToReferenceDataChanges(projectId, listener, options = {}) {
    const normalized = normalizedProjectId(projectId);
    const eventTarget = options.eventTarget === undefined ? defaultEventTarget() : options.eventTarget;
    if (!normalized || typeof listener !== 'function' || !eventTarget?.addEventListener) return () => {};

    const handler = event => {
        if (normalizedProjectId(event?.detail?.projectId) !== normalized) return;
        listener(event.detail);
    };
    eventTarget.addEventListener(REFERENCE_DATA_CHANGED_EVENT, handler);
    return () => eventTarget.removeEventListener?.(REFERENCE_DATA_CHANGED_EVENT, handler);
}

export function installHostedReferenceDataCacheInvalidation(options = {}) {
    const eventTarget = options.eventTarget === undefined ? defaultEventTarget() : options.eventTarget;
    const storage = options.storage === undefined ? defaultSessionStorage() : options.storage;
    if (!eventTarget?.addEventListener) return () => {};

    const handler = event => {
        const detail = event?.detail || {};
        if (detail.storeName !== 'reference_data') return;
        const projectId = detail.key || detail.projectId || detail.record?.project_id;
        if (!normalizedProjectId(projectId)) return;
        invalidateReferenceDataCache(projectId, {
            storage,
            eventTarget,
            source: detail.source || 'hosted-cache-updated'
        });
    };

    eventTarget.addEventListener('hosted-cache-updated', handler);
    return () => eventTarget.removeEventListener?.('hosted-cache-updated', handler);
}

export function createReferenceDataLoader(options = {}) {
    const projectId = normalizedProjectId(options.projectId);
    const fetchRecords = options.fetchRecords;
    const storage = options.storage === undefined ? defaultSessionStorage() : options.storage;
    if (typeof fetchRecords !== 'function') throw new TypeError('Reference-data loader requires fetchRecords.');

    let current = Object.create(null);
    let loadRevision = 0;

    const load = async ({ preferCache = true } = {}) => {
        const revision = ++loadRevision;
        if (preferCache) {
            const cached = readReferenceDataCache(projectId, storage);
            if (cached) {
                if (revision === loadRevision) current = cached;
                return current;
            }
        }

        const records = await fetchRecords(projectId);
        const next = createReferenceDataDictionary(records);
        if (revision !== loadRevision) return current;

        current = next;
        writeReferenceDataCache(projectId, current, storage);
        return current;
    };

    return {
        get current() {
            return current;
        },
        load,
        refresh() {
            return load({ preferCache: false });
        }
    };
}
