const { getLeagueInfo } = require('../../lib/footballData');

module.exports = async (req, res) => {
  try {
    const { data, stale } = await getLeagueInfo(req.query.league);
    if (stale) res.setHeader('X-Data-Stale', '1');
    res.status(200).json(data);
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Unknown league' });
    console.error('league error:', e.message || e);
    res.status(502).json({ error: 'Error fetching league info' });
  }
};
