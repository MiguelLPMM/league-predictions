// The self-serve "is this you" flow for guest (no-account) entries: the
// sign-in prompt (guestClaimPrompt.js) and the Profile page use these. All of
// it is plain RLS-protected reads/writes; approving is admin-only (RPC).
import { supabaseClient as sb } from '../supabaseClient.js';

const check = ({ data, error }) => {
    if (error) throw error;
    return data;
};

// Every unclaimed guest identity, grouped by guest_key (one real person can
// span several leagues/seasons). Visible to anyone: it is only names.
export async function listUnclaimedGuestIdentities() {
    const rows = check(await sb.from('entries')
        .select('guest_key, guest_display_name, league_seasons(league, season_year)')
        .is('user_id', null)
        .order('guest_display_name'));

    const byKey = new Map();
    rows.forEach((row) => {
        if (!byKey.has(row.guest_key)) {
            byKey.set(row.guest_key, { guestKey: row.guest_key, displayName: row.guest_display_name, seasons: [] });
        }
        if (row.league_seasons) byKey.get(row.guest_key).seasons.push(row.league_seasons);
    });
    byKey.forEach((identity) => identity.seasons.sort((a, b) => a.league.localeCompare(b.league) || a.season_year - b.season_year));
    return [...byKey.values()];
}

// The caller's own pending request (a user has at most one), or null.
export async function getMyPendingClaim(userId) {
    const req = check(await sb.from('guest_claim_requests')
        .select('id, guest_key, created_at')
        .eq('requested_by_user_id', userId).eq('status', 'pending').maybeSingle());
    if (!req) return null;

    const entry = check(await sb.from('entries')
        .select('guest_display_name').eq('guest_key', req.guest_key).is('user_id', null).limit(1).maybeSingle());
    return { id: req.id, guestKey: req.guest_key, displayName: entry?.guest_display_name || req.guest_key, createdAt: req.created_at };
}

// True once the user owns a fixed_rank entry (only possible through a merge).
// From then on self-serve requests are refused by RLS; only the admin can merge more.
export async function hasCompletedMerge(userId) {
    const row = check(await sb.from('entries')
        .select('id').eq('user_id', userId).eq('entry_mode', 'fixed_rank').limit(1).maybeSingle());
    return Boolean(row);
}

export async function hasDismissedPrompt(userId) {
    const row = check(await sb.from('guest_claim_dismissals').select('user_id').eq('user_id', userId).maybeSingle());
    return Boolean(row);
}

export async function dismissPrompt(userId) {
    const { error } = await sb.from('guest_claim_dismissals').insert({ user_id: userId });
    if (error && error.code !== '23505') throw error; // already dismissed is fine
}

export async function requestClaim(userId, guestKey) {
    const { error } = await sb.from('guest_claim_requests').insert({ guest_key: guestKey, requested_by_user_id: userId });
    if (error) throw error;
}

export async function cancelClaim(requestId) {
    const { error } = await sb.from('guest_claim_requests').delete().eq('id', requestId);
    if (error) throw error;
}
