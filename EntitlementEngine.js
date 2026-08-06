// ══════════════════════════════════════════════════════════════════════════════
// EntitlementEngine — Centralized Feature Flag & Entitlement Manager
//
// Single source of truth for what users can see and do in Mapplex.
// Replaces the legacy billing/gating helpers with one workspace-authoritative API.
//
// Architecture:
//   Supabase (feature_flags + plan_entitlements)
//     ↓ boot-time fetch, cached in localStorage
//   EntitlementEngine (singleton)
//     ↓ resolves 3-state per feature
//   UI components
//     → accessible / paywalled / hidden
//
// Plan tiers: free -> pro -> geova_ai (Teams) -> enterprise
// Product policy:
//   free     = solo workspace
//   pro      = owner + 1 invited member, 14-day edit history
//   geova_ai = larger Teams workspace, 30-day edit history
//
// Usage:
//   import { Entitlement } from '../services/EntitlementEngine.js';
//
//   Entitlement.can('data_export_gpkg')    // → true/false (silent)
//   Entitlement.guard('data_export_gpkg')  // → true/false (shows paywall)
//   Entitlement.state('data_export_gpkg')  // → 'accessible'|'paywalled'|'hidden'
//   Entitlement.meta('data_export_gpkg')   // → { label, badge, badgeColor, ... }
//   Entitlement.tier                       // → 'free'|'pro'|'geova_ai'|'enterprise'
//   Entitlement.isPro()                    // → boolean (any paid tier)
// ══════════════════════════════════════════════════════════════════════════════

import { WorkspaceManager } from '../modules/workspace/WorkspaceManager.js';
import { Capacitor } from '@capacitor/core';

// ── Constants ────────────────────────────────────────────────────────────────
const CACHE_KEY = '_mplx_entitlements';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const TIER_ALIASES = {
    basic: 'free',
    team: 'geova_ai',
    teams: 'geova_ai',
};
const PAID_TIERS = new Set(['pro', 'geova_ai', 'enterprise']);

/** Feature states */
export const FEATURE_STATE = {
    ACCESSIBLE: 'accessible',
    PAYWALLED:  'paywalled',
    HIDDEN:     'hidden',
};

// ── Hardcoded fallback (offline safety net) ──────────────────────────────────
// If Supabase is unreachable AND no cache exists, this drives gating.
// Minimal set — errs on the side of NOT blocking known-free features.
const FALLBACK_FLAGS = [
    { id: 'data_export_geojson', label: 'GeoJSON Export', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Free', badge_color: 'emerald' },
    { id: 'gps_capture', label: 'GPS Quick Capture', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Free', badge_color: 'emerald' },
    { id: 'data_export_gpkg', label: 'GeoPackage Export', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'data_export_csv', label: 'CSV Export', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Free', badge_color: 'emerald' },
    { id: 'data_export_kmz', label: 'KMZ Export', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Free', badge_color: 'emerald' },
    { id: 'map_export_pdf', label: 'PDF Map Export', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'smart_logic_ui', label: 'Smart Form Logic', is_enabled: true, paywall_reason: 'SMART_LOGIC', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'lexicon', label: 'Lexicon Registry', is_enabled: true, paywall_reason: 'SMART_LOGIC', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'gallery_photo', label: 'Gallery Photo Capture', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'geova_ai_chat', label: 'Geova AI Assistant', is_enabled: true, paywall_reason: 'SMART_LOGIC', badge_label: 'Pro', badge_color: 'violet' },
    { id: 'analytics_ai_query', label: 'AI Query Engine', is_enabled: true, paywall_reason: 'SMART_LOGIC', badge_label: 'Pro', badge_color: 'violet' },
    { id: 'team_access', label: 'Team Collaboration', is_enabled: true, paywall_reason: 'TEAM_ACCESS', badge_label: 'Pro+', badge_color: 'indigo' },
    { id: 'realtime_sync', label: 'Real-time Sync', is_enabled: true, paywall_reason: 'TEAM_ACCESS', badge_label: 'Pro+', badge_color: 'indigo' },
    { id: 'audit_trail', label: 'Audit Trail', is_enabled: true, paywall_reason: 'TEAM_ACCESS', badge_label: 'Pro+', badge_color: 'indigo' },
    { id: 'spatial_join', label: 'Living Form', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'data_import_spreadsheet', label: 'CSV / Excel Import', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'data_import_reference', label: 'Reference Zone Import', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'layer_completion_indicator', label: 'Completion Indicator', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'layer_symbology', label: 'Classification / Symbology', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'gps_tracking', label: 'GPS Tracking Tools', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Free', badge_color: 'emerald' },
    { id: 'redlining', label: 'Redlining & Markup', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Free', badge_color: 'emerald' },
    { id: 'quick_capture', label: 'Quick Capture Mode', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'slope_profiler', label: 'Slope Profiler', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'cad_import', label: 'CAD Manager (DXF)', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
    { id: 'shp_import', label: 'Shp Manager (SHP)', is_enabled: true, paywall_reason: 'PRO_EXPORT', badge_label: 'Pro', badge_color: 'amber' },
];
const FALLBACK_FREE_FEATURES = ['data_export_geojson', 'gps_capture', 'data_export_kmz', 'data_export_csv', 'gps_tracking', 'redlining'];
const FALLBACK_PRO_FEATURES = [
    ...FALLBACK_FREE_FEATURES,
    'data_export_gpkg',
    'map_export_pdf',
    'smart_logic_ui',
    'lexicon',
    'gallery_photo',
    'geova_ai_chat',
    'analytics_ai_query',
    'spatial_join',
    'data_import_spreadsheet',
    'data_import_reference',
    'layer_completion_indicator',
    'layer_symbology',
    'quick_capture',
    'slope_profiler',
    'cad_import',
    'shp_import',
    'team_access',
    'realtime_sync',
    'audit_trail',
];
const FALLBACK_TEAM_FEATURES = [
    ...FALLBACK_PRO_FEATURES,
];
const FALLBACK_ENTITLEMENTS = [
    ...FALLBACK_FREE_FEATURES.map(feature_id => ({ plan_tier: 'free', feature_id })),
    ...FALLBACK_PRO_FEATURES.map(feature_id => ({ plan_tier: 'pro', feature_id })),
    ...FALLBACK_TEAM_FEATURES.map(feature_id => ({ plan_tier: 'geova_ai', feature_id })),
    ...FALLBACK_TEAM_FEATURES.map(feature_id => ({ plan_tier: 'enterprise', feature_id })),
];

// ── Internal state ───────────────────────────────────────────────────────────
/** @type {Map<string, object>} featureId → flag row */
let _flagsMap = new Map();
/** @type {Map<string, Set<string>>} planTier → Set<featureId> */
let _entitlementMap = new Map();
/** @type {boolean} */
let _booted = false;
/** @type {Function|null} */
let _unsubWorkspace = null;
/** @type {Function|null} */
let _guardPresenter = null;

// ══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function _normalizeTier(tier) {
    const normalized = String(tier || 'free').toLowerCase();
    return TIER_ALIASES[normalized] || normalized;
}

function _resolveTier() {
    // Guest/local mode must never inherit a paid workspace from cached state.
    if (localStorage.getItem('guestMode') === 'true') return 'free';

    // 1. WorkspaceManager (authoritative)
    const ws = WorkspaceManager.activeWorkspace;
    if (ws?.subscription_tier) return _normalizeTier(ws.subscription_tier);

    // 2. Cached profile bridge
    const cached = window.cachedUserProfile;
    if (cached?.subscription_tier) return _normalizeTier(cached.subscription_tier);
    if (cached?.plan_type === 'pro') return 'pro';

    // 3. Native mobile fallback
    if (Capacitor.getPlatform() !== 'web') {
        try {
            const raw = localStorage.getItem('_mplx_ent');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed?.s === 'active') return 'pro';
            }
        } catch (_) { /* ignore */ }
    }

    return 'free';
}

function _loadCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (!cached._ts || Date.now() - cached._ts > CACHE_TTL_MS) return null;
        return cached;
    } catch (_) { return null; }
}

function _saveCache(flags, entitlements) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            flags,
            entitlements,
            _ts: Date.now(),
        }));
    } catch (_) { /* quota exceeded — non-fatal */ }
}

function _mergeFallbackGaps(flags, entitlements) {
    const flagIds = new Set((flags || []).map(f => f.id));
    const mergedFlags = [...(flags || [])];
    const mergedEntitlements = [...(entitlements || [])];

    for (const fallbackFlag of FALLBACK_FLAGS) {
        if (flagIds.has(fallbackFlag.id)) continue;
        mergedFlags.push(fallbackFlag);

        for (const fallbackEntitlement of FALLBACK_ENTITLEMENTS) {
            if (fallbackEntitlement.feature_id === fallbackFlag.id) {
                mergedEntitlements.push(fallbackEntitlement);
            }
        }
    }

    return { flags: mergedFlags, entitlements: mergedEntitlements };
}

function _hydrateFromData(flags, entitlements) {
    const merged = _mergeFallbackGaps(flags, entitlements);

    _flagsMap.clear();
    _entitlementMap.clear();

    for (const f of merged.flags) {
        _flagsMap.set(f.id, f);
    }
    for (const e of merged.entitlements) {
        const planTier = _normalizeTier(e.plan_tier);
        if (!_entitlementMap.has(planTier)) {
            _entitlementMap.set(planTier, new Set());
        }
        _entitlementMap.get(planTier).add(e.feature_id);
    }
}

function _hydrateFromFallback() {
    _hydrateFromData(FALLBACK_FLAGS, FALLBACK_ENTITLEMENTS);
}

/**
 * Build the presentation-neutral notice emitted when a feature is paywalled.
 * The application composition root decides how to render this notice.
 *
 * @param {string} featureId
 * @param {object|undefined} flag
 * @returns {{ featureId: string, label: string, paywallReason: string, message: string, toastType: string }}
 */
export function createEntitlementGuardNotice(featureId, flag) {
    const label = flag?.label || featureId;
    return {
        featureId,
        label,
        paywallReason: flag?.paywall_reason || 'PRO_EXPORT',
        message: `${label} requires an upgrade.`,
        toastType: 'error',
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC API — Exported as singleton `Entitlement`
// ══════════════════════════════════════════════════════════════════════════════

export const Entitlement = {

    /**
     * Configure presentation for blocked feature guards.
     * Returns a restore callback for tests and temporary application shells.
     *
     * @param {Function|null} presenter
     * @returns {Function}
     */
    setGuardPresenter(presenter) {
        const previousPresenter = _guardPresenter;
        _guardPresenter = typeof presenter === 'function' ? presenter : null;
        return () => {
            _guardPresenter = previousPresenter;
        };
    },

    /**
     * Boot the entitlement engine. Call once after auth.
     * Fetches the manifest from Supabase, falls back to cache, then fallback.
     *
     * @param {object} supabase — Supabase client instance
     */
    async boot(supabase) {
        // 1. Try Supabase fetch
        let fetched = false;
        if (supabase) {
            try {
                const [flagsRes, entRes] = await Promise.all([
                    supabase.from('feature_flags').select('*').order('sort_order'),
                    supabase.from('plan_entitlements').select('plan_tier, feature_id, usage_limit'),
                ]);

                if (!flagsRes.error && !entRes.error && flagsRes.data?.length) {
                    _hydrateFromData(flagsRes.data, entRes.data || []);
                    _saveCache(flagsRes.data, entRes.data || []);
                    fetched = true;
                    console.log(`[Entitlement] ✓ Loaded ${flagsRes.data.length} flags, ${entRes.data?.length || 0} entitlements from Supabase`);
                }
            } catch (err) {
                console.warn('[Entitlement] Supabase fetch failed, trying cache:', err.message);
            }
        }

        // 2. Fallback to localStorage cache
        if (!fetched) {
            const cached = _loadCache();
            if (cached?.flags?.length) {
                _hydrateFromData(cached.flags, cached.entitlements || []);
                console.log(`[Entitlement] ⚡ Loaded ${cached.flags.length} flags from cache`);
                fetched = true;
            }
        }

        // 3. Last resort: hardcoded fallback
        if (!fetched) {
            _hydrateFromFallback();
            console.log('[Entitlement] ⚠ Using hardcoded fallback manifest');
        }

        // Subscribe to workspace changes for live tier updates
        if (!_unsubWorkspace) {
            _unsubWorkspace = WorkspaceManager.onChange(() => {
                // Tier changed — all state() calls will now re-resolve automatically
                console.log(`[Entitlement] Workspace changed → tier is now: ${_resolveTier()}`);
            });
        }

        _booted = true;
    },

    /** True if boot() has completed. */
    get isBooted() { return _booted; },

    /** Current subscription tier string. */
    get tier() { return _resolveTier(); },

    /**
     * Returns true if the workspace has ANY paid subscription.
     * Direct replacement for legacy paid-workspace checks.
     */
    isPro() {
        return PAID_TIERS.has(_resolveTier());
    },

    /**
     * Human-readable tier label (e.g. "Pro Workspace").
     * Direct replacement for legacy tier-label helpers.
     */
    getTierLabel() {
        const tier = _resolveTier();
        if (!tier || tier === 'free') return 'Basic Workspace';
        if (tier === 'geova_ai') return 'Teams Workspace';
        return tier.charAt(0).toUpperCase() + tier.slice(1) + ' Workspace';
    },

    /**
     * Resolve the 3-state for a feature.
     * @param {string} featureId
     * @returns {'accessible'|'paywalled'|'hidden'}
     */
    state(featureId) {
        const flag = _flagsMap.get(featureId);

        // Unknown feature IDs should not silently unlock gated flows.
        if (!flag) return FEATURE_STATE.PAYWALLED;

        // Kill switch
        if (!flag.is_enabled) return FEATURE_STATE.HIDDEN;

        // Schedule window
        const now = Date.now();
        if (flag.available_from && new Date(flag.available_from).getTime() > now) {
            return FEATURE_STATE.HIDDEN;
        }
        if (flag.available_until && new Date(flag.available_until).getTime() < now) {
            return FEATURE_STATE.HIDDEN;
        }

        // Entitlement check
        const tier = _resolveTier();
        const tierEntitlements = _entitlementMap.get(tier);
        if (tierEntitlements && tierEntitlements.has(featureId)) {
            return FEATURE_STATE.ACCESSIBLE;
        }

        return FEATURE_STATE.PAYWALLED;
    },

    /**
     * Silent check — returns true if the user can use the feature.
     * Does NOT show any UI. Use for conditional rendering.
     * @param {string} featureId
     * @returns {boolean}
     */
    can(featureId) {
        return this.state(featureId) === FEATURE_STATE.ACCESSIBLE;
    },

    /**
     * Guard call — returns true if allowed, false if blocked.
     * When paywalled, emits a presentation-neutral notice. Use at the top of
     * click handlers; the composition root controls the paywall and toast UI.
     *
     *   if (!Entitlement.guard('data_export_gpkg')) return;
     *
     * @param {string} featureId
     * @returns {boolean}
     */
    guard(featureId) {
        const st = this.state(featureId);
        if (st === FEATURE_STATE.ACCESSIBLE) return true;
        if (st === FEATURE_STATE.HIDDEN) return false;

        const flag = _flagsMap.get(featureId);
        _guardPresenter?.(createEntitlementGuardNotice(featureId, flag));
        return false;
    },

    /**
     * Get metadata for a feature (for badge rendering, tooltips).
     * @param {string} featureId
     * @returns {{ label: string, badge: string, badgeColor: string, paywallReason: string, description: string }|null}
     */
    meta(featureId) {
        const flag = _flagsMap.get(featureId);
        if (!flag) return null;
        return {
            label: flag.label,
            badge: flag.badge_label || 'Pro',
            badgeColor: flag.badge_color || 'amber',
            paywallReason: flag.paywall_reason,
            description: flag.description || '',
            category: flag.category,
            uiModule: flag.ui_module,
        };
    },

    /**
     * Returns the full feature registry (for admin panels, debugging).
     * @returns {Map<string, object>}
     */
    getRegistry() {
        return new Map(_flagsMap);
    },

    /**
     * Force a re-fetch of the manifest. Call after a plan upgrade webhook.
     * @param {object} supabase
     */
    async refresh(supabase) {
        await this.boot(supabase);
    },

    /**
     * Clear all cached data on logout.
     */
    clearOnLogout() {
        localStorage.removeItem(CACHE_KEY);
        _flagsMap.clear();
        _entitlementMap.clear();
        _booted = false;
        if (_unsubWorkspace) {
            _unsubWorkspace();
            _unsubWorkspace = null;
        }
    },
};

// ── Legacy Compatibility Exports ─────────────────────────────────────────────
// These exist so the migration is seamless. New code should use Entitlement.*.
export function isPro() { return Entitlement.isPro(); }
export function getTierLabel() { return Entitlement.getTierLabel(); }
