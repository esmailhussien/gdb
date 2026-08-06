// RealtimeSyncService - Live multi-device sync via Supabase Realtime.
//
// Subscribes to hosted workspace tables and patches remote changes into the
// local cache without queueing another sync back to Supabase.

import { supabase, isSupabaseConfigured } from '../storage/supabaseClient.js';
import { dbAPI, STORES } from '../storage/db.js';

let _channel = null;
let _activeWorkspaceId = null;
let _subscriptionStatus = 'idle';
let _subscribeToken = 0;
let _recentLocalWrites = new Map();

const REALTIME_TABLES = ['features', 'layers', 'projects', 'forms', 'lexicons', 'reference_data'];
const DEDUP_WINDOW_MS = 3000;

export function markLocalWrite(recordId) {
    if (!recordId) return;
    _recentLocalWrites.set(recordId, Date.now());

    if (_recentLocalWrites.size > 1000) {
        const now = Date.now();
        for (const [key, ts] of _recentLocalWrites) {
            if (now - ts > DEDUP_WINDOW_MS * 2) {
                _recentLocalWrites.delete(key);
            }
        }
    }
}

function _isRecentLocalWrite(recordId) {
    const ts = _recentLocalWrites.get(recordId);
    if (!ts) return false;
    if (Date.now() - ts < DEDUP_WINDOW_MS) return true;
    _recentLocalWrites.delete(recordId);
    return false;
}

async function subscribe(workspaceId) {
    if (!workspaceId || !isSupabaseConfigured()) {
        console.warn('[Realtime] Cannot subscribe: no workspace or Supabase not configured');
        return;
    }

    if (_channel && _activeWorkspaceId === workspaceId && ['subscribing', 'subscribed'].includes(_subscriptionStatus)) {
        return;
    }

    if (_channel) {
        await unsubscribe();
    }

    _activeWorkspaceId = workspaceId;
    _subscriptionStatus = 'subscribing';
    const token = ++_subscribeToken;

    try {
        const channel = supabase.channel(`ws:${workspaceId}`, {
            config: { broadcast: { self: false } }
        });
        _channel = channel;

        for (const table of REALTIME_TABLES) {
            for (const event of ['INSERT', 'UPDATE']) {
                channel.on(
                    'postgres_changes',
                    {
                        event,
                        schema: 'public',
                        table,
                        filter: `workspace_id=eq.${workspaceId}`
                    },
                    (payload) => _handleChange(table, payload)
                );
            }

            channel.on(
                'postgres_changes',
                {
                    event: 'DELETE',
                    schema: 'public',
                    table
                },
                (payload) => _handleChange(table, payload)
            );
        }

        channel.subscribe((status, err) => {
            if (token !== _subscribeToken || channel !== _channel) return;

            if (status === 'SUBSCRIBED') {
                _subscriptionStatus = 'subscribed';
                console.log(`[Realtime] Subscribed to workspace ${workspaceId}`);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                _subscriptionStatus = 'error';
                console.warn(`[Realtime] Subscription ${status.toLowerCase()} for workspace ${workspaceId}:`, err?.message || err || '');
            } else if (status === 'CLOSED') {
                _subscriptionStatus = 'closed';
            }
        });
    } catch (err) {
        console.warn('[Realtime] Subscription failed (non-fatal, SWR fallback active):', err.message || err);
        _channel = null;
        _subscriptionStatus = 'idle';
    }
}

async function unsubscribe() {
    const channel = _channel;
    const workspaceId = _activeWorkspaceId;

    _subscribeToken++;
    _channel = null;
    _activeWorkspaceId = null;
    _subscriptionStatus = 'idle';

    if (channel) {
        try {
            await supabase.removeChannel(channel);
            console.log('[Realtime] Unsubscribed from workspace:', workspaceId);
        } catch (err) {
            console.warn('[Realtime] Unsubscribe error (non-fatal):', err.message || err);
        }
    }

    _recentLocalWrites.clear();
}

async function _handleChange(table, payload) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    try {
        const storeName = STORES[table.toUpperCase()] || table;

        if (eventType === 'INSERT' || eventType === 'UPDATE') {
            if (!newRecord?.id) return;
            if (newRecord.workspace_id && String(newRecord.workspace_id) !== String(_activeWorkspaceId)) return;
            if (_isRecentLocalWrite(newRecord.id)) return;

            await dbAPI.put(storeName, newRecord, { cacheOnly: true });

            console.log(`[Realtime] <- ${eventType} ${table}/${newRecord.id}`);
            _notifyCacheUpdated(table, storeName, eventType, newRecord);
            return;
        }

        if (eventType === 'DELETE') {
            const deletedId = oldRecord?.id;
            if (!deletedId) return;
            if (oldRecord?.workspace_id && String(oldRecord.workspace_id) !== String(_activeWorkspaceId)) return;
            if (_isRecentLocalWrite(deletedId)) return;

            const existing = await dbAPI.get(storeName, deletedId);
            if (!existing) return;

            const recordWorkspaceId = existing.workspace_id || oldRecord?.workspace_id;
            if (!recordWorkspaceId || String(recordWorkspaceId) !== String(_activeWorkspaceId)) return;

            await dbAPI.delete(storeName, deletedId, { cacheOnly: true });

            console.log(`[Realtime] <- DELETE ${table}/${deletedId}`);
            _notifyCacheUpdated(table, storeName, 'DELETE', existing || oldRecord);
        }
    } catch (err) {
        console.warn(`[Realtime] Change handler error (${eventType} ${table}):`, err.message || err);
    }
}

function _notifyCacheUpdated(table, storeName, eventType, record = null) {
    if (typeof document === 'undefined') return;

    if (table === 'features') {
        const projectId = record?.project_id;
        if (!projectId) {
            document.dispatchEvent(new CustomEvent('reload-map-features'));
            return;
        }

        document.dispatchEvent(new CustomEvent('hosted-cache-updated', {
            detail: {
                storeName,
                key: projectId,
                upserted: eventType === 'DELETE' ? 0 : 1,
                deleted: eventType === 'DELETE' ? 1 : 0,
                source: 'realtime',
                eventType
            }
        }));
        return;
    }

    document.dispatchEvent(new CustomEvent('hosted-cache-updated', {
        detail: {
            storeName,
            key: record?.project_id || record?.id || null,
            upserted: eventType === 'DELETE' ? 0 : 1,
            deleted: eventType === 'DELETE' ? 1 : 0,
            source: 'realtime',
            eventType
        }
    }));
}

export const RealtimeSyncService = {
    subscribe,
    unsubscribe,
    markLocalWrite,

    get isConnected() {
        return _channel !== null && !['closed', 'error'].includes(_subscriptionStatus);
    },

    get status() {
        return _subscriptionStatus;
    },

    get activeWorkspaceId() {
        return _activeWorkspaceId;
    }
};
