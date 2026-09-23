const { getLeagueInfo } = require('../../lib/leagueData');

module.exports = async (req, res) => {
  try {
    res.status(200).json(await getLeagueInfo(req.query.league));
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Unknown league' });
    console.error('league error:', e.message || e);
    res.status(502).json({ error: 'Error fetching league info' });
  }
};
