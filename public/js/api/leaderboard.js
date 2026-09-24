// Read-only data access for the leaderboard page. Everything relies on RLS:
// league/season/standings/teams/profiles are public; entries (and their
// picks) are visible once the league season is revealed, plus your own.
import { supabaseClient as sb } from '../supabaseClient.js';

const check = ({ data, error }) => {
    if (error) throw error;
    return data;
};

export async function getLeague(slug) {
    return check(await sb.from('leagues').select('slug, name').eq('slug', slug).maybeSingle());
}

export async function getCurrentSeasonYear() {
    const row = check(await sb.from('seasons').select('season_year').eq('is_current', true).maybeSingle());
    return row?.season_year ?? null;
}

// Every season on record for a league, newest first (feeds the selector).
export async function listLeagueSeasons(slug) {
    return check(await sb.from('league_seasons')
        .select('id, season_year, status, reveal_unlocked, first_kickoff_at, is_manual, seasons(label)')
        .eq('league', slug)
        .order('season_year', { ascending: false }));
}

// Actual (or current partial) table, best position first.
export async function getStandings(leagueSeasonId) {
    return check(await sb.from('standings')
        .select('position, team_id')
        .eq('league_season_id', leagueSeasonId)
        .order('position'));
}

export async function getSeasonTeams(leagueSeasonId) {
    const rows = check(await sb.from('season_teams')
        .select('teams(id, name, crest)')
        .eq('league_season_id', leagueSeasonId));
    return new Map(rows.map((r) => [r.teams.id, r.teams]));
}

// Entries with their picks, earliest submission first.
export async function getEntries(leagueSeasonId) {
    return check(await sb.from('entries')
        .select('id, user_id, guest_key, guest_display_name, late_gameweek, created_at, entry_picks(position, team_id)')
        .eq('league_season_id', leagueSeasonId)
        .order('created_at', { ascending: true }));
}

export async function getProfiles(userIds) {
    if (!userIds.length) return new Map();
    const rows = check(await sb.from('profiles').select('id, display_name, avatar_url').in('id', userIds));
    return new Map(rows.map((r) => [r.id, r]));
}
