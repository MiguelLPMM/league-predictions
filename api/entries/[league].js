const { saveEntry } = require('../../lib/entries');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const league = req.params?.league ?? req.query.league;
    res.status(200).json(await saveEntry({ league, token, teamIds: req.body?.teamIds }));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.code });
    console.error('entries error:', e.message || e);
    res.status(500).json({ error: 'server_error' });
  }
};
