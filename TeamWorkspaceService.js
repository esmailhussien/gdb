import { supabase } from '../storage/supabaseClient.js';

export async function resolveProjectWorkspaceId(projectId, fallbackWorkspaceId = null) {
    const { data: rows } = await supabase
        .from('projects')
        .select('workspace_id')
        .eq('id', projectId)
        .limit(1);

    return rows && rows.length > 0 ? rows[0].workspace_id : fallbackWorkspaceId;
}

export async function fetchWorkspaceMembers(workspaceId) {
    if (!workspaceId) return [];

    const { data: rows, error } = await supabase
        .from('workspace_members')
        .select('member_email, role, status, user_id')
        .eq('workspace_id', workspaceId);

    if (error) throw error;

    const profileIds = [...new Set((rows || []).map(row => row.user_id).filter(Boolean))];
    const profileMap = {};

    if (profileIds.length > 0) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name, email')
            .in('id', profileIds);
        (profiles || []).forEach(profile => { profileMap[profile.id] = profile; });
    }

    return (rows || []).map(row => {
        const profile = row.user_id ? profileMap[row.user_id] : null;
        const email = profile?.email || row.member_email || '';
        return {
            user_id: row.user_id || null,
            member_email: email,
            email,
            full_name: profile?.full_name || email.split('@')[0] || 'Team Member',
            role: row.role || 'viewer',
            status: row.status || 'active'
        };
    });
}

export async function fetchProfilesByIds(profileIds) {
    if (!profileIds?.length) return [];

    const { data } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', profileIds);

    return data || [];
}

export async function getCurrentTeamUser() {
    const { data: { user } } = await supabase.auth.getUser();
    return user || null;
}

export async function sendWorkspaceInvite({ email, role, projectId }) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
        throw new Error('Missing active session token locally. Please log in again.');
    }

    const { data, error } = await supabase.functions.invoke('invite-member', {
        body: { email, role, projectId },
        headers: {
            Authorization: `Bearer ${session.access_token}`
        }
    });

    return { data, error, userId: session.user.id };
}

export async function removeWorkspaceMemberByEmail({ workspaceId, email }) {
    const { error } = await supabase
        .from('workspace_members')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('member_email', email);

    if (error) throw error;
}
