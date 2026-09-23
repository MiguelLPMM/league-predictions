const { getTeams } = require('../../lib/leagueData');

module.exports = async (req, res) => {
  try {
    res.status(200).json(await getTeams(req.query.league, req.query.season));
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Unknown league' });
    console.error('teams error:', e.message || e);
    res.status(502).json({ error: 'Error fetching teams' });
  }
};
