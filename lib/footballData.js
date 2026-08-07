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

// season START year (e.g. 2024 for 2024/25)
const START_MONTH = 7; // August
function currentSeason() {
  const now = new Date();
  return now.getMonth() >= START_MONTH ? now.getFullYear() : now.getFullYear() - 1;
}

// TTLs (override via env if you want)
const TTL_LEAGUE_MS = Number(process.env.TTL_LEAGUE_MS ?? 24 * 60 * 60 * 1000); // 24h
const TTL_TEAMS_MS  = Number(process.env.TTL_TEAMS_MS  ?? 6 * 60 * 60 * 1000);  // 6h

// ---------- Tiny cache with de-dupe + stale serving ----------
// NOTE: on serverless (Vercel) this only helps within a warm lambda instance —
// cold starts get a fresh, empty cache. Fine for a low-traffic app; swap for
// Vercel KV/Upstash if the football-data.org rate limit becomes an issue.
const cache = new Map(); // key -> { ts, data, pending }
function getKey(kind, code) { return `${kind}:${code}`; }

async function cached(key, ttl, loader) {
  const entry = cache.get(key) || {};
  const fresh = entry.ts && (Date.now() - entry.ts) < ttl;

  if (fresh && entry.data) return { data: entry.data, stale: false };

  // de-duplicate in-flight fetches
  if (!entry.pending) {
    entry.pending = (async () => {
      try {
        const data = await loader();
        cache.set(key, { ts: Date.now(), data, pending: null });
        return data;
      } catch (e) {
        // keep old data if any, but rethrow so caller can decide
        cache.set(key, { ts: entry.ts, data: entry.data ?? null, pending: null });
        throw e;
      }
    })();
    cache.set(key, entry);
  }

  try {
    const data = await entry.pending;
    return { data, stale: false };
  } catch (e) {
    // serve stale if available
    if (entry.data) return { data: entry.data, stale: true };
    throw e;
  }
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

async function getLeagueInfo(slug) {
  const code = compCode(slug);
  if (!code) { const e = new Error('Unknown league'); e.status = 404; throw e; }

  const key = getKey('league', code);
  return cached(key, TTL_LEAGUE_MS, async () => {
    const text = await fetchFD(`https://api.football-data.org/v4/competitions/${code}`);
    const json = JSON.parse(text);
    return { name: json.name, emblem: json.emblem, code };
  });
}

async function getTeams(slug) {
  const code = compCode(slug);
  if (!code) { const e = new Error('Unknown league'); e.status = 404; throw e; }

  const season = currentSeason();
  const key = getKey('teams', `${code}:${season}`);
  return cached(key, TTL_TEAMS_MS, async () => {
    const text = await fetchFD(
      `https://api.football-data.org/v4/competitions/${code}/teams?season=${season}`
    );
    const json = JSON.parse(text);
    return (json.teams || []).map(t => ({
      id: t.id,
      name: t.shortName || t.tla || t.name,
      badge: t.crest || ''
    }));
  });
}

module.exports = { FD_COMP, currentSeason, getLeagueInfo, getTeams };
