require('dotenv').config();

// ---------- Config ----------
const FD_COMP = {
  premierleague: 'PL',
  laliga: 'PD',
  bundesliga: 'BL1',
  seriea: 'SA',
  ligue1: 'FL1',
  ligaportugal: 'PPL',
};

// season START year (e.g. 2024 for 2024/25). Fallback only: the sync asks the
// API which season is current.
const START_MONTH = 7; // August
function currentSeason() {
  const now = new Date();
  return now.getMonth() >= START_MONTH ? now.getFullYear() : now.getFullYear() - 1;
}

// ---------- Robust fetch with 429 handling ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchFD(url, { maxRetries = 3 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= maxRetries) {
    const r = await fetch(url, { headers: { 'X-Auth-Token': process.env.FD_TOKEN || '' } });
    const text = await r.text();
    if (r.ok) return text;

    // 429 (rate limit) => honor Retry-After or backoff 1s,2s,4s...
    if (r.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(r.headers.get('Retry-After')) || Math.pow(2, attempt) * 1000;
      await sleep(retryAfter);
      attempt++;
      continue;
    }

    // other errors
    lastErr = new Error(`FD HTTP ${r.status} ${text}`);
    break;
  }
  throw lastErr || new Error('FD fetch failed');
}

function compCode(slug) {
  return FD_COMP[String(slug || '').toLowerCase()];
}

const fdJson = async (path) => JSON.parse(await fetchFD(`https://api.football-data.org/v4${path}`));

const teamName = (t) => t.shortName || t.tla || t.name;

// A match counts as "kicked off" unless it is postponed/cancelled, once its
// scheduled time has passed or the API already reports it as under way/done.
const KICKED_OFF = new Set(['IN_PLAY', 'PAUSED', 'LIVE', 'FINISHED', 'SUSPENDED', 'AWARDED']);
const NOT_PLAYED = new Set(['POSTPONED', 'CANCELLED']);
const DONE = new Set(['FINISHED', 'AWARDED', 'CANCELLED']);

/**
 * Fetch everything the app caches for one league season: 2-3 API calls
 * (matches, standings, plus competition info when no season is given).
 * Returns the payload shape apply_league_sync() expects.
 */
async function fetchLeagueSnapshot(slug, seasonYear) {
  const code = compCode(slug);
  if (!code) { const e = new Error('Unknown league'); e.status = 404; throw e; }

  let year = seasonYear;
  let info = null;
  if (!year) {
    info = await fdJson(`/competitions/${code}`);
    year = Number(String(info.currentSeason?.startDate || '').slice(0, 4)) || currentSeason();
  }

  const matchesJson = await fdJson(`/competitions/${code}/matches?season=${year}`);
  const matches = matchesJson.matches || [];
  const comp = matchesJson.competition || info || {};
  const now = Date.now();

  const live = matches.filter(m => !NOT_PLAYED.has(m.status));
  const kickoffs = live.map(m => Date.parse(m.utcDate)).filter(Number.isFinite);
  const startedDays = live
    .filter(m => KICKED_OFF.has(m.status) || Date.parse(m.utcDate) <= now)
    .map(m => m.matchday)
    .filter(Number.isFinite);

  const standingsJson = await fdJson(`/competitions/${code}/standings?season=${year}`);
  const total = (standingsJson.standings || []).find(s => s.type === 'TOTAL') || (standingsJson.standings || [])[0];
  const table = total?.table || [];

  let teams = table.map(r => ({ fd_team_id: r.team.id, name: teamName(r.team), crest: r.team.crest || '' }));
  if (!teams.length) {
    const teamsJson = await fdJson(`/competitions/${code}/teams?season=${year}`);
    teams = (teamsJson.teams || []).map(t => ({ fd_team_id: t.id, name: teamName(t), crest: t.crest || '' }));
  }

  return {
    league_name: comp.name || null,
    league_emblem: comp.emblem || null,
    season_year: year,
    first_kickoff_at: kickoffs.length ? new Date(Math.min(...kickoffs)).toISOString() : null,
    started_matchweek: startedDays.length ? Math.max(...startedDays) : 0,
    total_matchweeks: matches.length ? Math.max(...matches.map(m => m.matchday).filter(Number.isFinite)) : null,
    all_finished: matches.length > 0 && matches.every(m => DONE.has(m.status)),
    teams,
    standings: table.map(r => ({
      position: r.position,
      fd_team_id: r.team.id,
      played: r.playedGames,
      won: r.won,
      draw: r.draw,
      lost: r.lost,
      points: r.points,
      goals_for: r.goalsFor,
      goals_against: r.goalsAgainst,
    })),
  };
}

module.exports = { FD_COMP, currentSeason, compCode, fetchLeagueSnapshot };
