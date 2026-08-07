require('dotenv').config();
const express = require('express');
const path = require('path');
const { currentSeason, getLeagueInfo, getTeams } = require('../lib/footballData');

const app = express();
app.use(express.json());

app.get('/sw.js', (_req, res, next) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  next();
});

app.use(express.static(path.resolve(__dirname, '../public')));

// ---------- Routes ----------
app.get('/', (_req, res) => res.redirect('/premierleague.html'));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, hasToken: Boolean(process.env.FD_TOKEN), season: currentSeason() })
);

// League info (name + emblem), cached 24h
app.get('/api/league/:league', async (req, res) => {
  try {
    const { data, stale } = await getLeagueInfo(req.params.league);
    if (stale) res.set('X-Data-Stale', '1');
    res.json(data);
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Unknown league' });
    console.error('league error:', e.message || e);
    res.status(502).json({ error: 'Error fetching league info' });
  }
});

// Teams (short name + crest), cached 6h
app.get('/api/teams/:league', async (req, res) => {
  try {
    const { data, stale } = await getTeams(req.params.league);
    if (stale) res.set('X-Data-Stale', '1');
    res.json(data);
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Unknown league' });
    console.error('teams error:', e.message || e);
    res.status(502).json({ error: 'Error fetching teams' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT} (season=${currentSeason()})`));
