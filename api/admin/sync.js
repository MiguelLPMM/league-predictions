const { requireAdmin } = require('../../lib/admin');
const { syncLeague } = require('../../lib/syncLeague');

// Admin "refresh league data" button. Same throttled sync as cron and
// sync-on-submit: a league is never synced more than once a minute.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    await requireAdmin(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    res.status(200).json(await syncLeague(req.body?.league));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.code || 'error' });
    console.error('admin sync error:', e.message || e);
    res.status(502).json({ error: 'sync_failed' });
  }
};
