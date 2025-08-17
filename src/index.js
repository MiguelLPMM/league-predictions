// src/index.js
require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../public')));

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
const now = new Date();
const SEASON = now.getMonth() >= START_MONTH ? now.getFullYear() : now.getFullYear() - 1;

// TTLs (override via env if you want)
const TTL_LEAGUE_MS = Number(process.env.TTL_LEAGUE_MS ?? 24 * 60 * 60 * 1000); // 24h
const TTL_TEAMS_MS  = Number(process.env.TTL_TEAMS_MS  ?? 6 * 60 * 60 * 1000);  // 6h

// ---------- Tiny cache with de-dupe + stale serving ----------
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

// ---------- Routes ----------
app.get('/', (_req, res) => res.redirect('/premierleague.html'));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, hasToken: Boolean(process.env.FD_TOKEN), season: SEASON })
);

// League info (name + emblem), cached 24h
app.get('/api/league/:league', async (req, res) => {
  try {
    const slug = String(req.params.league || '').toLowerCase();
    const code = FD_COMP[slug];
    if (!code) return res.status(404).json({ error: 'Unknown league' });

    const key = getKey('league', code);
    const { data, stale } = await cached(key, TTL_LEAGUE_MS, async () => {
      const text = await fetchFD(`https://api.football-data.org/v4/competitions/${code}`);
      const json = JSON.parse(text);
      return { name: json.name, emblem: json.emblem, code };
    });

    if (stale) res.set('X-Data-Stale', '1');
    res.json(data);
  } catch (e) {
    console.error('league error:', e.message || e);
    res.status(502).json({ error: 'Error fetching league info' });
  }
});

// Teams (short name + crest), cached 6h
app.get('/api/teams/:league', async (req, res) => {
  try {
    const slug = String(req.params.league || '').toLowerCase();
    const code = FD_COMP[slug];
    if (!code) return res.status(404).json({ error: 'Unknown league' });

    const key = getKey('teams', `${code}:${SEASON}`);
    const { data, stale } = await cached(key, TTL_TEAMS_MS, async () => {
      const text = await fetchFD(
        `https://api.football-data.org/v4/competitions/${code}/teams?season=${SEASON}`
      );
      const json = JSON.parse(text);
      return (json.teams || []).map(t => ({
        id: t.id,
        name: t.shortName || t.tla || t.name,
        badge: t.crest || ''
      }));
    });

    if (stale) res.set('X-Data-Stale', '1');
    res.json(data);
  } catch (e) {
    console.error('teams error:', e.message || e);
    res.status(502).json({ error: 'Error fetching teams' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT} (season=${SEASON})`));
