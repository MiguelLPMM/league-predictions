const { supabaseAdmin } = require('./supabaseAdmin');

function notFound() {
  const e = new Error('Unknown league');
  e.status = 404;
  return e;
}

async function getLeagueInfo(slug) {
  const { data, error } = await supabaseAdmin()
    .from('leagues').select('name, emblem, fd_code').eq('slug', String(slug || '').toLowerCase()).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound();
  return { name: data.name, emblem: data.emblem, code: data.fd_code };
}

// Teams of a league season (default: the current season), from the cache.
async function getTeams(slug, seasonYear) {
  const db = supabaseAdmin();
  const league = String(slug || '').toLowerCase();

  let year = Number(seasonYear) || null;
  if (!year) {
    const { data, error } = await db.from('seasons').select('season_year').eq('is_current', true).maybeSingle();
    if (error) throw error;
    year = data?.season_year;
  }

  const { data: ls, error: lsErr } = await db
    .from('league_seasons').select('id').eq('league', league).eq('season_year', year).maybeSingle();
  if (lsErr) throw lsErr;
  if (!ls) throw notFound();

  const { data, error } = await db
    .from('season_teams').select('teams(id, fd_team_id, name, crest)').eq('league_season_id', ls.id);
  if (error) throw error;

  return data
    .map(r => r.teams)
    .map(t => ({ id: t.fd_team_id ?? t.id, name: t.name, badge: t.crest || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { getLeagueInfo, getTeams };
