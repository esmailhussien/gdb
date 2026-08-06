// ══════════════════════════════════════════════════════════════════════════════
// OfflineSyncService.js — Pro User "Download for Offline" Service
//
// Fetches ALL data for a hosted project from Supabase and saves it into the
// local SQLite / IndexedDB store so the user can work fully offline.
//
// Usage:
//   import { OfflineSyncService } from './OfflineSyncService.js';
//   const result = await OfflineSyncService.downloadProjectForOffline(projectId, onProgress);
// ══════════════════════════════════════════════════════════════════════════════

import { supabase } from '../storage/supabaseClient.js';
import { dbAPI, STORES } from '../storage/db.js';
import { invalidateStorageTypeCache } from '../ai/dataSourceBridge.js';
import { WorkspaceManager } from '../modules/workspace/WorkspaceManager.js';

function sanitizeHostedProjectPayload(project) {
    const payload = { ...(project || {}) };
    delete payload.status;
    delete payload._offlineCached;
    delete payload._conflict_resolved;
    return payload;
}

function sanitizeHostedLayerPayload(layer) {
    const payload = { ...(layer || {}) };
    delete payload.isVisible;
    delete payload.status;
    delete payload._offlineCached;
    delete payload._conflict_resolved;
    return payload;
}

function sanitizeHostedFormPayload(form) {
    const payload = { ...(form || {}) };
    delete payload.project_id;
    delete payload.status;
    delete payload._offlineCached;
    delete payload._conflict_resolved;
    return payload;
}

function sanitizeHostedFeaturePayload(feature) {
    const payload = { ...(feature || {}) };
    delete payload.created_by;
    delete payload.status;
    delete payload._offlineCached;
    delete payload._conflict_resolved;
    delete payload._sync_base;
    delete payload._sync_base_recorded_at;
    delete payload.bbox_min_lng;
    delete payload.bbox_min_lat;
    delete payload.bbox_max_lng;
    delete payload.bbox_max_lat;
    return payload;
}

function throwIfDownloadAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Download cancelled.');
    error.name = 'AbortError';
    throw error;
}

export class OfflineSyncService {

    /**
     * Downloads a hosted project and all its sub-entities into local storage.
     *
     * @param {string} projectId - ID of the hosted project to download.
     * @param {function} onProgress - Optional callback: onProgress({ step, total, label })
     * @param {AbortSignal|null} signal - Optional cancellation signal.
     * @returns {{ success: boolean, counts: object, error?: string, cancelled?: boolean }}
     */
    static async downloadProjectForOffline(projectId, onProgress = null, signal = null) {
        const report = (step, total, label) => {
            if (onProgress) onProgress({ step, total, label });
        };

        const counts = { layers: 0, forms: 0, features: 0, lexicons: 0, deletedFeatures: 0 };

        try {
            throwIfDownloadAborted(signal);
            // Step 1 — Fetch & cache the project row itself
            report(1, 6, 'Downloading project info…');
            const { data: project, error: projErr } = await supabase
                .from('projects')
                .select('*')
                .eq('id', projectId)
                .single();
            if (projErr) throw projErr;
            throwIfDownloadAborted(signal);

            // Mark it as having a local copy so future reads hit local first
            await dbAPI.put(STORES.PROJECTS, { ...project, _offlineCached: true }, {
                cacheOnly: true,
                preserveTimestamps: true
            });

            // Step 2 — Layers
            report(2, 6, 'Downloading layers…');
            throwIfDownloadAborted(signal);
            const { data: layers, error: layerErr } = await supabase
                .from('layers')
                .select('*')
                .eq('project_id', projectId);
            if (layerErr) throw layerErr;
            throwIfDownloadAborted(signal);

            // MOB-06 Audit Fix: Use putBatch instead of sequential put().
            // Each JS↔Native bridge crossing costs ~2-5ms on Android.
            // For 200 layers this saves up to 1 second of blocking I/O.
            if (layers && layers.length > 0) {
                await dbAPI.putBatch(STORES.LAYERS, layers, projectId, {
                    cacheOnly: true,
                    preserveTimestamps: true
                });
                counts.layers = layers.length;
            }

            // Step 3 — Forms
            report(3, 6, 'Downloading forms…');
            throwIfDownloadAborted(signal);
            const formIds = (layers || []).map(l => l.form_id).filter(Boolean);
            if (formIds.length > 0) {
                const { data: forms, error: formErr } = await supabase
                    .from('forms')
                    .select('*')
                    .in('id', formIds);

                if (formErr) throw formErr;
                throwIfDownloadAborted(signal);

                const formsToSave = (forms || []).map(form => ({
                    ...form,
                    project_id: form.project_id || projectId
                }));

                if (formsToSave.length > 0) {
                    await dbAPI.putBatch(STORES.FORMS, formsToSave, projectId, {
                        cacheOnly: true,
                        preserveTimestamps: true
                    });
                    counts.forms = formsToSave.length;
                }
            }

            // Step 4 — Features (batch in chunks to avoid payload limits)
            // QW-08 Audit Fix: Delta sync — only fetch features updated since the
            // last successful offline cache. For a project with 10,000 features where
            // only 50 changed, this reduces download from ~20MB to ~100KB.
            report(4, 6, 'Downloading features…');
            throwIfDownloadAborted(signal);
            const CHUNK_SIZE = 500;
            let from = 0;
            let hasMore = true;

            const previousCache = OfflineSyncService.getOfflineCacheInfo(projectId);
            const lastSyncedAt = previousCache?.lastSyncedAt || previousCache?.cachedAt || null;
            const syncStartedAt = new Date().toISOString();
            let nextFeatureWatermark = lastSyncedAt;

            while (hasMore) {
                throwIfDownloadAborted(signal);
                let featureQuery = supabase
                    .from('features')
                    .select('*')
                    .eq('project_id', projectId)
                    .lte('updated_at', syncStartedAt)
                    .order('updated_at', { ascending: true })
                    .order('id', { ascending: true });

                // Delta sync: only fetch features updated since last cache
                if (lastSyncedAt) {
                    featureQuery = featureQuery.gt('updated_at', lastSyncedAt);
                }

                const { data: featureChunk, error: featErr } = await featureQuery
                    .range(from, from + CHUNK_SIZE - 1);

                if (featErr) throw featErr;
                throwIfDownloadAborted(signal);

                // MOB-06 Audit Fix: putBatch uses executeSet() which is 10× faster
                // than individual bridge crossings. For 5,000 features this reduces
                // download time from 25+ seconds to ~2 seconds.
                if (featureChunk && featureChunk.length > 0) {
                    await dbAPI.putBatch(STORES.FEATURES, featureChunk, projectId, {
                        cacheOnly: true,
                        preserveTimestamps: true
                    });
                    counts.features += featureChunk.length;
                    featureChunk.forEach(feature => {
                        if (feature.updated_at && (!nextFeatureWatermark || feature.updated_at > nextFeatureWatermark)) {
                            nextFeatureWatermark = feature.updated_at;
                        }
                    });
                }

                hasMore = (featureChunk?.length === CHUNK_SIZE);
                from += CHUNK_SIZE;
            }

            // Reconcile hosted deletes. Delta pulls only fetch updated rows, so a
            // small ID-only pass removes local cache rows that no longer exist
            // remotely while preserving unsynced local upserts.
            const remoteFeatureIds = new Set();
            from = 0;
            hasMore = true;
            while (hasMore) {
                throwIfDownloadAborted(signal);
                const { data: idChunk, error: idErr } = await supabase
                    .from('features')
                    .select('id')
                    .eq('project_id', projectId)
                    .order('id', { ascending: true })
                    .range(from, from + CHUNK_SIZE - 1);

                if (idErr) throw idErr;
                throwIfDownloadAborted(signal);
                (idChunk || []).forEach(row => {
                    if (row.id) remoteFeatureIds.add(row.id);
                });
                hasMore = (idChunk?.length === CHUNK_SIZE);
                from += CHUNK_SIZE;
            }

            const pendingFeatureUpserts = new Set(
                (await dbAPI.getAll(STORES.PENDING_SYNC))
                    .filter(item => item?.action === 'upsert' && item?.store === STORES.FEATURES && item?.record_id)
                    .map(item => item.record_id)
            );
            const localFeatures = await dbAPI.getByIndex(STORES.FEATURES, 'project_id', projectId);
            for (const feature of localFeatures) {
                throwIfDownloadAborted(signal);
                if (!remoteFeatureIds.has(feature.id) && !pendingFeatureUpserts.has(feature.id)) {
                    await dbAPI.delete(STORES.FEATURES, feature.id, { cacheOnly: true });
                    counts.deletedFeatures += 1;
                }
            }

            // Step 5 — Lexicons (Workspace scoped)
            if (project.workspace_id) {
                throwIfDownloadAborted(signal);
                report(5, 6, 'Downloading lexicons…');
                const { data: lexicons, error: lexErr } = await supabase
                    .from('lexicons')
                    .select('*')
                    .eq('workspace_id', project.workspace_id);
                
                if (!lexErr && lexicons && lexicons.length > 0) {
                    await dbAPI.putBatch(STORES.LEXICONS, lexicons, projectId, {
                        cacheOnly: true,
                        preserveTimestamps: true
                    });
                    counts.lexicons = lexicons.length;
                }
            }

            // Step 6 — Persist a marker so the app knows this project has an offline cache
            report(6, 6, 'Finalizing…');
            throwIfDownloadAborted(signal);
            const cacheKey = `offline_cache_${projectId}`;
            localStorage.setItem(cacheKey, JSON.stringify({
                projectId,
                cachedAt: new Date().toISOString(),
                lastSyncedAt: nextFeatureWatermark || syncStartedAt,
                counts,
            }));

            console.log(`[OfflineSyncService] Project ${projectId} downloaded:`, counts);
            return { success: true, counts };

        } catch (err) {
            console.error('[OfflineSyncService] Download failed:', err);
            return {
                success: false,
                counts,
                error: err.message || String(err),
                cancelled: err?.name === 'AbortError'
            };
        }
    }

    /**
     * Uploads a local-only project to Supabase, converting it to a Hosted project.
     * 
     * @param {string} projectId - ID of the local project to upload.
     * @param {function} onProgress - Optional callback: onProgress({ step, total, label })
     * @returns {{ success: boolean, counts: object, error?: string }}
     */
    static async uploadLocalProjectToHosted(projectId, onProgress = null) {
        const report = (step, total, label, percentage) => {
            if (onProgress) onProgress({ step, total, label, percentage });
        };

        const counts = { layers: 0, forms: 0, features: 0 };

        try {
            report(1, 5, 'Reading local data…', 5);
            
            // 1. Fetch EVERYTHING while the project is still considered 'local' 
            // so we don't accidentally query Supabase for zero records.
            const project = await dbAPI.get(STORES.PROJECTS, projectId);
            if (!project) throw new Error("Local project not found.");
            if (project.storage_type === 'hosted') throw new Error("Project is already hosted.");

            const layers = await dbAPI.getByIndex(STORES.LAYERS, 'project_id', projectId);
            const features = await dbAPI.getByIndex(STORES.FEATURES, 'project_id', projectId);
            const layerIds = (layers || []).map(l => l.id);
            
            let forms = [];
            const formIds = layers.map(l => l.form_id).filter(Boolean);
            if (formIds.length > 0) {
                const allForms = await dbAPI.getAll(STORES.FORMS);
                forms = allForms.filter(f => formIds.includes(f.id));
            }

            // ── UPG-01 Audit Fix: Two-Phase Commit Pattern ──────────────────
            // PHASE 1: Upload everything WHILE the project is still 'local'.
            // Use direct Supabase calls — bypass dbAPI routing entirely.
            // This prevents the split-brain scenario where the project is
            // marked 'hosted' but only 2,000 of 5,000 features uploaded.

            // ── UPG-02 Audit Fix: Inject workspace_id ────────────────────────
            // Guest projects have workspace_id = null. On migration, stamp the
            // active workspace so Supabase RLS policies don't reject the insert.
            const wsId = project.workspace_id
                || WorkspaceManager.activeWorkspaceId
                || window.cachedUserProfile?.workspace_id;
            if (!wsId) {
                throw new Error('Cannot migrate: no workspace context. Please sign in first.');
            }

            // Stamp workspace_id on all entities
            project.workspace_id = wsId;
            for (const layer of layers) { layer.workspace_id = wsId; }
            for (const form of forms) { form.workspace_id = wsId; }
            for (const feat of features) { feat.workspace_id = wsId; }

            // 2. Upload Project (still marked as 'local' in local DB)
            report(2, 5, 'Creating cloud project…', 15);
            const hostedProject = sanitizeHostedProjectPayload({ ...project, storage_type: 'hosted', updated_at: new Date().toISOString() });
            const { error: projUpErr } = await supabase.from('projects').upsert(hostedProject, { onConflict: 'id' });
            if (projUpErr) throw projUpErr;

            // 3. Upload Layers and Forms (direct Supabase — bypass dbAPI)
            report(3, 5, 'Uploading layers & forms…', 25);
            for (const layer of layers) {
                layer.updated_at = new Date().toISOString();
                const { error } = await supabase.from('layers').upsert(sanitizeHostedLayerPayload(layer), { onConflict: 'id' });
                if (error) throw error;
                counts.layers++;
            }
            for (const form of forms) {
                form.updated_at = new Date().toISOString();
                const { error } = await supabase.from('forms').upsert(sanitizeHostedFormPayload(form), { onConflict: 'id' });
                if (error) throw error;
                counts.forms++;
            }

            // 4. Upload Features in chunks (direct Supabase)
            report(4, 5, 'Starting feature upload…', 35);
            const totalFeatures = features.length || 1;
            const CHUNK_SIZE = 50;
            for (let i = 0; i < features.length; i += CHUNK_SIZE) {
                const chunk = features.slice(i, i + CHUNK_SIZE)
                    .map(f => sanitizeHostedFeaturePayload({ ...f, updated_at: new Date().toISOString() }));
                const { error } = await supabase.from('features').upsert(chunk, { onConflict: 'id' });
                if (error) throw error;
                counts.features += chunk.length;
                
                const pct = 35 + ((counts.features / totalFeatures) * 60);
                report(4, 5, `Uploaded ${counts.features} of ${totalFeatures} features…`, Math.min(95, pct));
                
                // Yield the microtask queue so the UI progress circle can animate
                await new Promise(r => setTimeout(r, 20));
            }

            // ── PHASE 2: Atomic Cutover ───────────────────────────────────────
            // Only flip to 'hosted' AFTER 100% of data is uploaded successfully.
            // This is the "point of no return" — safe because all data is on the server.
            report(5, 5, 'Finalizing upload…', 98);
            project.storage_type = 'hosted';
            project.updated_at = new Date().toISOString();
            invalidateStorageTypeCache(projectId);
            await dbAPI.put(STORES.PROJECTS, project);

            report(5, 5, 'Upload complete!', 100);
            console.log(`[OfflineSyncService] Project ${projectId} uploaded (two-phase commit):`, counts);
            return { success: true, counts };

        } catch (err) {
            console.error('[OfflineSyncService] Upload failed:', err);
            
            // Recovery: Ensure the local project stays 'local' so the user
            // doesn't end up with a half-synced orphaned state.
            try {
                const proj = await dbAPI.get(STORES.PROJECTS, projectId);
                if (proj && proj.storage_type !== 'local') {
                    proj.storage_type = 'local';
                    invalidateStorageTypeCache(projectId);
                    await dbAPI.put(STORES.PROJECTS, proj);
                }
            } catch (e) { /* ignore recovery failure */ }
            
            return { success: false, counts, error: err.message || String(err) };
        }
    }

    /**
     * Returns cached metadata for a project, or null if not cached.
     * @param {string} projectId
     */
    static getOfflineCacheInfo(projectId) {
        try {
            const raw = localStorage.getItem(`offline_cache_${projectId}`);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }

    /**
     * Clears the offline cache marker for a project (does not delete local DB rows).
     * @param {string} projectId
     */
    static clearOfflineCacheInfo(projectId) {
        localStorage.removeItem(`offline_cache_${projectId}`);
    }
}
