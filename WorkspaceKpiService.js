import { supabase } from '../storage/supabaseClient.js';

function toUtcDayBoundary(value, endOfDay = false) {
    if (!value) return null;
    return `${value}${endOfDay ? 'T23:59:59Z' : 'T00:00:00Z'}`;
}

/**
 * Read the existing workspace KPI RPC without exposing Supabase to views.
 * Result projection remains owned by the calling feature so this boundary
 * does not absorb presentation policy.
 */
export async function fetchWorkspaceKpis({
    workspaceId,
    projectId = null,
    dateFrom = null,
    dateTo = null
} = {}) {
    const { data, error } = await supabase.rpc('get_workspace_kpis', {
        p_workspace_id: workspaceId,
        p_project_id: projectId,
        p_start_date: toUtcDayBoundary(dateFrom),
        p_end_date: toUtcDayBoundary(dateTo, true)
    });

    if (error) throw error;
    return data;
}
