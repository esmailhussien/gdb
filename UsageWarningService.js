import { WorkspaceManager } from '../modules/workspace/WorkspaceManager.js';
import { supabase } from '../storage/supabaseClient.js';

const CHECK_THROTTLE_MS = 30_000;
const WARNING_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function warningRank(level) {
    if (level === 'critical') return 3;
    if (level === 'high') return 2;
    if (level === 'medium') return 1;
    return 0;
}

function storageLevelFromPercent(percent) {
    if (percent >= 100) return 'critical';
    if (percent >= 90) return 'high';
    if (percent >= 75) return 'medium';
    return null;
}

function aiLevelFromCredits(credits) {
    if (credits <= 0) return 'critical';
    if (credits <= 10) return 'high';
    if (credits <= 20) return 'medium';
    return null;
}

function formatMb(value) {
    const mb = Math.max(0, toNumber(value));
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    if (mb >= 10) return `${mb.toFixed(1)} MB`;
    return `${mb.toFixed(2)} MB`;
}

export function createUsageWarningNotice(metric, level, limits) {
    if (metric === 'storage') {
        const pct = Math.round(toNumber(limits.storage_percent));
        const used = formatMb(limits.storage_used_mb);
        const limit = formatMb(limits.effective_storage_limit_mb);
        return {
            metric,
            level,
            message: level === 'critical'
                ? `Workspace storage is full (${used} of ${limit}). Add extra storage or delete data to keep syncing.`
                : `Workspace storage is almost full (${pct}% used). Add extra storage or delete old data.`,
            toastType: level === 'medium' ? 'warning' : 'error',
            durationMs: 6500,
            action: { eventName: 'billing:open-recharge', detail: { tab: 'storage' } }
        };
    }

    if (metric === 'ai') {
        const available = Math.max(0, Math.round(toNumber(limits.ai_available, limits.ai_credits)));
        return {
            metric,
            level,
            message: level === 'critical'
                ? 'AI points are empty. Buy extra AI points to continue using Geova.'
                : `AI points are running low (${available} left). Buy extra AI points to keep working.`,
            toastType: level === 'medium' ? 'warning' : 'error',
            durationMs: 6500,
            action: { eventName: 'billing:open-recharge', detail: { tab: 'ai' } }
        };
    }

    return null;
}

function fallbackLimits(workspace) {
    if (!workspace) return null;
    const baseLimit = toNumber(workspace.storage_limit_mb, 0);
    const effectiveLimit = toNumber(workspace.effective_storage_limit_mb, baseLimit);
    const extraStorage = Math.max(0, effectiveLimit - baseLimit);
    const usedBytes = toNumber(workspace.storage_used_bytes, 0);
    const usedMb = usedBytes / (1024 * 1024);
    const percent = effectiveLimit > 0 ? (usedMb / effectiveLimit) * 100 : 0;
    const aiCredits = toNumber(workspace.ai_credits, 0);
    const pendingCredits = toNumber(workspace.pending_credits, 0);
    const aiAvailable = Math.max(0, aiCredits - pendingCredits);

    return {
        workspace_id: workspace.id || WorkspaceManager.activeWorkspaceId,
        subscription_tier: workspace.subscription_tier || 'basic',
        base_storage_limit_mb: baseLimit,
        active_extra_storage_mb: extraStorage,
        effective_storage_limit_mb: effectiveLimit,
        storage_used_bytes: usedBytes,
        storage_used_mb: usedMb,
        storage_percent: percent,
        ai_credits: aiCredits,
        pending_credits: pendingCredits,
        ai_available: aiAvailable,
        storage_warning_level: storageLevelFromPercent(percent),
        ai_warning_level: aiLevelFromCredits(aiAvailable),
    };
}

class _UsageWarningService {
    constructor() {
        this._booted = false;
        this._lastCheckAtByWorkspace = new Map();
        this._limitsByWorkspace = new Map();
        this._warningPresenter = null;
    }

    setWarningPresenter(presenter) {
        const previousPresenter = this._warningPresenter;
        this._warningPresenter = typeof presenter === 'function' ? presenter : null;
        return () => {
            this._warningPresenter = previousPresenter;
        };
    }

    boot() {
        if (this._booted) return;
        this._booted = true;

        WorkspaceManager.onChange(() => {
            this.checkNow('workspace-change', { force: true });
        });

        document.addEventListener('geova:credits-updated', () => {
            this.checkNow('credits-updated', { force: true });
        });

        window.addEventListener('online', () => {
            this.checkNow('online', { force: true });
        });

        this.checkNow('boot');
    }

    getCachedLimits(workspaceId = WorkspaceManager.activeWorkspaceId) {
        return workspaceId ? this._limitsByWorkspace.get(workspaceId) || null : null;
    }

    async refreshLimits({ force = false } = {}) {
        const workspaceId = WorkspaceManager.activeWorkspaceId;
        const workspace = WorkspaceManager.activeWorkspace;
        if (!workspaceId || !workspace) return null;

        const now = Date.now();
        const lastCheckAt = this._lastCheckAtByWorkspace.get(workspaceId) || 0;
        if (!force && now - lastCheckAt < CHECK_THROTTLE_MS) {
            return this.getCachedLimits(workspaceId) || fallbackLimits(workspace);
        }
        this._lastCheckAtByWorkspace.set(workspaceId, now);

        let limits = null;
        if (navigator.onLine) {
            try {
                const { data, error } = await supabase.rpc('get_workspace_effective_limits', {
                    p_workspace_id: workspaceId
                });
                if (!error) {
                    limits = Array.isArray(data) ? data[0] : data;
                } else {
                    console.warn('[UsageWarning] Effective limits RPC failed:', error.message);
                }
            } catch (err) {
                console.warn('[UsageWarning] Effective limits fetch failed:', err);
            }
        }

        if (!limits) limits = fallbackLimits(workspace);
        if (!limits) return null;

        this._patchWorkspace(limits);
        this._limitsByWorkspace.set(workspaceId, limits);
        document.dispatchEvent(new CustomEvent('workspace:limits-updated', { detail: limits }));
        return limits;
    }

    async checkNow(source = 'manual', { force = false } = {}) {
        const limits = await this.refreshLimits({ force });
        if (!limits) return null;
        this._emitWarnings(limits, source);
        return limits;
    }

    _patchWorkspace(limits) {
        const workspace = WorkspaceManager.activeWorkspace;
        if (!workspace || workspace.id !== limits.workspace_id) return;

        workspace.effective_storage_limit_mb = toNumber(limits.effective_storage_limit_mb, workspace.storage_limit_mb);
        workspace.active_extra_storage_mb = toNumber(limits.active_extra_storage_mb, 0);
        workspace.storage_percent = toNumber(limits.storage_percent, 0);
        workspace.ai_credits = toNumber(limits.ai_credits, workspace.ai_credits);
        workspace.pending_credits = toNumber(limits.pending_credits, workspace.pending_credits);
        workspace.ai_available = toNumber(limits.ai_available, workspace.ai_credits);

        if (window.cachedUserProfile?.workspace_id === limits.workspace_id) {
            Object.assign(window.cachedUserProfile, {
                base_storage_limit_mb: toNumber(limits.base_storage_limit_mb, workspace.storage_limit_mb),
                active_extra_storage_mb: workspace.active_extra_storage_mb,
                effective_storage_limit_mb: workspace.effective_storage_limit_mb,
                storage_limit_mb: workspace.effective_storage_limit_mb,
                storage_used_bytes: toNumber(limits.storage_used_bytes, workspace.storage_used_bytes),
                ai_credits: workspace.ai_credits,
                pending_credits: workspace.pending_credits,
            });
        }
    }

    _emitWarnings(limits, source) {
        const workspaceId = limits.workspace_id;
        const storageLevel = limits.storage_warning_level || storageLevelFromPercent(toNumber(limits.storage_percent));
        const aiLevel = limits.ai_warning_level || aiLevelFromCredits(toNumber(limits.ai_available, limits.ai_credits));

        if (storageLevel && this._shouldWarn(workspaceId, 'storage', storageLevel)) {
            this._warningPresenter?.(createUsageWarningNotice('storage', storageLevel, limits));
        }

        if (aiLevel && this._shouldWarn(workspaceId, 'ai', aiLevel)) {
            this._warningPresenter?.(createUsageWarningNotice('ai', aiLevel, limits));
        }

        console.log(`[UsageWarning] Checked ${workspaceId} from ${source}`);
    }

    _shouldWarn(workspaceId, metric, level) {
        const rank = warningRank(level);
        if (!workspaceId || !rank) return false;

        const key = `mplx_usage_warning:${workspaceId}:${metric}:${level}`;
        const lastShownAt = toNumber(localStorage.getItem(key), 0);
        if (Date.now() - lastShownAt < WARNING_COOLDOWN_MS) return false;

        for (const otherLevel of ['medium', 'high', 'critical']) {
            if (warningRank(otherLevel) > rank) continue;
            const otherKey = `mplx_usage_warning:${workspaceId}:${metric}:${otherLevel}`;
            if (otherLevel !== level && warningRank(otherLevel) < rank) {
                localStorage.removeItem(otherKey);
            }
        }

        localStorage.setItem(key, String(Date.now()));
        return true;
    }
}

export const UsageWarningService = new _UsageWarningService();
