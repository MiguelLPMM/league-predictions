require('dotenv').config();
const express = require('express');
const path = require('path');
const { currentSeason } = require('../lib/footballData');
const { getLeagueInfo, getTeams } = require('../lib/leagueData');

const app = express();
app.use(express.json());

app.get('/sw.js', (_req, res, next) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  next();
});

// Mirror Vercel's cleanUrls + the legacy per-league redirects, so dev matches production
const LEAGUES = 'premierleague|laliga|bundesliga|seriea|ligue1|ligaportugal';
const qs = (req) => (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
app.get(new RegExp(`^/(${LEAGUES})(\\.html)?$`), (req, res) =>
  res.redirect(`/predictions?league=${req.params[0]}`));
app.get(/^\/(.+)\.html$/, (req, res) => res.redirect(`/${req.params[0]}${qs(req)}`));

app.use(express.static(path.resolve(__dirname, '../public'), { extensions: ['html'] }));

// ---------- Routes ----------
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, hasToken: Boolean(process.env.FD_TOKEN), season: currentSeason() })
);

// League info (name + emblem), from the Supabase cache
app.get('/api/league/:league', async (req, res) => {
  try {
    res.json(await getLeagueInfo(req.params.league));
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Unknown league' });
    console.error('league error:', e.message || e);
    res.status(502).json({ error: 'Error fetching league info' });
  }
});

// Teams (short name + crest), from the Supabase cache
app.get('/api/teams/:league', async (req, res) => {
  try {
    res.json(await getTeams(req.params.league, req.query.season));
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Unknown league' });
    console.error('teams error:', e.message || e);
    res.status(502).json({ error: 'Error fetching teams' });
  }
});

app.post('/api/entries/:league', require('../api/entries/[league]'));
app.get('/api/cron/sync', require('../api/cron/sync'));

const PORT =process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT} (season=${currentSeason()})`));
