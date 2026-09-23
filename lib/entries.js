const { supabaseAdmin } = require('./supabaseAdmin');
const { syncLeague } = require('./syncLeague');

const SYNC_TIMEOUT_MS = 6000; // stay well inside the serverless function limit

const HTTP_BY_CODE = { not_found: 404, season_closed: 409, invalid_teams: 400, entry_locked: 409 };

function httpError(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  return e;
}

// Save (or late-submit) the signed-in user's predicted table for a league's
// current season. The token is verified here; the lock and late-entry rules
// are enforced in the database by save_entry().
async function saveEntry({ league, token, teamIds }) {
  const db = supabaseAdmin();

  const { data: auth, error: authErr } = await db.auth.getUser(token || '');
  if (authErr || !auth?.user) throw httpError(401, 'unauthorized', 'Sign in to save');

  if (!Array.isArray(teamIds)) throw httpError(400, 'invalid_teams', 'teamIds must be an array');

  const slug = String(league || '').toLowerCase();
  const { data: season } = await db.from('seasons').select('season_year').eq('is_current', true).maybeSingle();
  const { data: ls } = season
    ? await db.from('league_seasons')
        .select('id, first_kickoff_at').eq('league', slug).eq('season_year', season.season_year).maybeSingle()
    : { data: null };
  if (!ls) throw httpError(404, 'not_found', 'Unknown league');

  // After kickoff the matchweek badge must be fresh: sync this league first
  // (throttled to once a minute; on failure or timeout the stored value is used).
  const kickedOff = !ls.first_kickoff_at || Date.parse(ls.first_kickoff_at) <= Date.now();
  if (kickedOff) {
    await Promise.race([
      syncLeague(slug).catch((e) => console.error('sync-on-submit failed:', e.message || e)),
      new Promise((r) => setTimeout(r, SYNC_TIMEOUT_MS)),
    ]);
  }

  const { data, error } = await db.rpc('save_entry', {
    p_user_id: auth.user.id,
    p_league_season_id: ls.id,
    p_team_ids: teamIds,
  });
  if (error) {
    const code = Object.keys(HTTP_BY_CODE).find((c) => String(error.message).includes(c));
    if (!code) throw error;
    throw httpError(HTTP_BY_CODE[code], code);
  }
  return data;
}

module.exports = { saveEntry };
