const { compCode, fetchLeagueSnapshot } = require('./footballData');
const { supabaseAdmin } = require('./supabaseAdmin');

const MIN_INTERVAL = '60 seconds';

// Fetch a league season from football-data.org and mirror it into Supabase.
// No throttling here - callers are responsible for pacing (see syncLeague).
async function syncLeagueSeason(slug, seasonYear) {
  const db = supabaseAdmin();
  try {
    const payload = await fetchLeagueSnapshot(slug, seasonYear);
    const { error } = await db.rpc('apply_league_sync', { p_league: slug, p_payload: payload });
    if (error) throw new Error(`apply_league_sync: ${error.message}`);
    await db.rpc('record_league_sync_result', { p_league: slug, p_error: null });
    return { synced: true, season: payload.season_year, teams: payload.teams.length };
  } catch (e) {
    await db.rpc('record_league_sync_result', { p_league: slug, p_error: String(e.message || e).slice(0, 500) });
    throw e;
  }
}

// Throttled sync used by cron, the admin refresh button and sync-on-submit:
// a league is never synced more than once per minute, no matter who asks.
async function syncLeague(slug, seasonYear) {
  if (!compCode(slug)) { const e = new Error('Unknown league'); e.status = 404; throw e; }
  const { data: claimed, error } = await supabaseAdmin()
    .rpc('claim_league_sync', { p_league: slug, p_min_interval: MIN_INTERVAL });
  if (error) throw new Error(`claim_league_sync: ${error.message}`);
  if (!claimed) return { synced: false, skipped: 'throttled' };
  return syncLeagueSeason(slug, seasonYear);
}

module.exports = { syncLeague, syncLeagueSeason };
