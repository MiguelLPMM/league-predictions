// Data for the History charts: a player's score in every season of a league.
// Score = the same total |predicted rank - actual rank| the leaderboard uses (lower is
// better). Everything is read through RLS, so only entries the viewer may see (their own,
// or those of a revealed season) ever show up.
import { supabaseClient as sb } from '../supabaseClient.js';
import { computeOffsets } from '../scoring.js';
import { seasonLabel, LEAGUE_SLUGS } from '../leagues.js';

const check = ({ data, error }) => {
    if (error) throw error;
    return data;
};

// Every season of a league, oldest first, with its table (final or current partial).
async function loadLeagueTables(league) {
    const seasons = check(await sb.from('league_seasons')
        .select('id, season_year, status').eq('league', league).order('season_year'));
    const rows = seasons.length
        ? check(await sb.from('standings')
            .select('league_season_id, team_id, position').in('league_season_id', seasons.map((s) => s.id)))
        : [];
    const tables = new Map();
    rows.forEach((r) => {
        if (!tables.has(r.league_season_id)) tables.set(r.league_season_id, []);
        tables.get(r.league_season_id).push({ team_id: r.team_id, position: r.position });
    });
    return { seasons, tables };
}

function scoreEntry(entry, table) {
    const predicted = new Map(entry.entry_picks.map((p) => [p.team_id, p.position]));
    const { total, bangOn } = computeOffsets(predicted, table);
    return { score: total, bangOn };
}

const point = (entry, season, table, result) => ({
    year: season.season_year,
    score: result.score,
    bangOn: result.bangOn,
    late: entry.late_gameweek || 0,
    teams: table.length,
    live: season.status !== 'concluded', // the season is still being played: the score can still move
});

const axisSeason = (season, table) => ({
    year: season.season_year,
    label: seasonLabel(season.season_year),
    teams: table.length,
    live: season.status !== 'concluded',
});

// Everyone's history in one league, for the leaderboard's History view. Only seasons where
// somebody has a visible entry get a column.
export async function loadLeagueHistory(league, selfId = null) {
    const { seasons, tables } = await loadLeagueTables(league);
    const withTable = seasons.filter((s) => tables.get(s.id)?.length);
    const byId = new Map(withTable.map((s) => [s.id, s]));

    const entries = withTable.length
        ? check(await sb.from('entries')
            .select('id, league_season_id, user_id, guest_key, guest_display_name, guest_color, late_gameweek, created_at, entry_picks(position, team_id)')
            .in('league_season_id', withTable.map((s) => s.id)))
        : [];

    const userIds = [...new Set(entries.map((e) => e.user_id).filter(Boolean))];
    const profiles = new Map(userIds.length
        ? check(await sb.from('profiles').select('id, display_name, chart_color, created_at').in('id', userIds)).map((p) => [p.id, p])
        : []);

    // one line per real account, or per unclaimed guest (a merged guest is already the account)
    const byKey = new Map();
    const yearsWithEntries = new Set();
    entries.forEach((e) => {
        const season = byId.get(e.league_season_id);
        const table = tables.get(season.id);
        const key = e.user_id ? `u:${e.user_id}` : `g:${e.guest_key}`;
        if (!byKey.has(key)) {
            byKey.set(key, {
                key,
                name: (e.user_id ? profiles.get(e.user_id)?.display_name : e.guest_display_name) || 'Player',
                color: e.user_id ? profiles.get(e.user_id)?.chart_color : e.guest_color, // stable palette index (0-11)
                isSelf: Boolean(selfId && e.user_id === selfId),
                since: e.user_id ? profiles.get(e.user_id)?.created_at : null,
                points: [],
            });
        }
        const person = byKey.get(key);
        // how long this person has been around: the earliest of their account and their entries
        if (!person.since || (e.created_at && e.created_at < person.since)) person.since = e.created_at || person.since;
        person.points.push(point(e, season, table, scoreEntry(e, table)));
        yearsWithEntries.add(season.season_year);
    });

    // Order (the legend follows it): whoever has entries in this league from the earliest season
    // first; ties by who has been around longest (account or first entry), then by name.
    const series = [...byKey.values()];
    series.forEach((s) => s.points.sort((a, b) => a.year - b.year));
    series.sort((a, b) =>
        (a.points[0].year - b.points[0].year)
        || String(a.since || '').localeCompare(String(b.since || ''))
        || a.name.localeCompare(b.name));

    return {
        seasons: withTable.filter((s) => yearsWithEntries.has(s.season_year)).map((s) => axisSeason(s, tables.get(s.id))),
        series,
    };
}

// The signed-in user's own history in every league, for the Profile page:
// Map(league slug -> { seasons, series: [one line] }). A league's columns start at the
// season of the user's first entry there and run to the latest season with a table.
export async function loadMyHistory(userId) {
    const mine = check(await sb.from('entries')
        .select('id, league_season_id, late_gameweek, entry_picks(position, team_id), league_seasons(league, season_year)')
        .eq('user_id', userId));

    const myColor = check(await sb.from('profiles').select('chart_color').eq('id', userId).maybeSingle())?.chart_color;

    const out = new Map();
    await Promise.all(LEAGUE_SLUGS.map(async (league) => {
        const entries = mine.filter((e) => e.league_seasons?.league === league);
        if (!entries.length) { out.set(league, { seasons: [], series: [] }); return; }

        const { seasons, tables } = await loadLeagueTables(league);
        const bySeasonId = new Map(seasons.map((s) => [s.id, s]));
        const points = [];
        entries.forEach((e) => {
            const season = bySeasonId.get(e.league_season_id);
            const table = season && tables.get(season.id);
            if (table?.length) points.push(point(e, season, table, scoreEntry(e, table)));
        });
        points.sort((a, b) => a.year - b.year);
        if (!points.length) { out.set(league, { seasons: [], series: [] }); return; }

        const first = points[0].year;
        out.set(league, {
            seasons: seasons
                .filter((s) => s.season_year >= first && tables.get(s.id)?.length)
                .map((s) => axisSeason(s, tables.get(s.id))),
            series: [{ key: 'me', name: 'You', isSelf: true, color: myColor, points }],
        });
    }));
    return out;
}
