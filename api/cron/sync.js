const { syncLeague } = require('../../lib/syncLeague');

// Vercel Cron calls this with "Authorization: Bearer $CRON_SECRET". One league
// per invocation (see vercel.json for the staggered schedule); each run also
// counts as Supabase activity, which keeps the free project from pausing.
module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not configured' });
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  try {
    res.status(200).json(await syncLeague(req.query.league, Number(req.query.season) || undefined));
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Unknown league' });
    console.error('sync error:', e.message || e);
    res.status(502).json({ error: 'Sync failed' });
  }
};
