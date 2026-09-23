// One-off / occasional: mirror past and current seasons from football-data.org
// into Supabase. Usage: node scripts/backfill.js [year ...]   (default 2023..2026)
// Paced at one league season every 20s (2-3 API calls each) to stay under the
// free tier's 10 calls/minute. Finished seasons are stored once and never
// re-fetched by the app afterwards. Needs FD_TOKEN, SUPABASE_URL and
// SUPABASE_SECRET_KEY in .env.
require('dotenv').config();
const { FD_COMP } = require('../lib/footballData');
const { syncLeagueSeason } = require('../lib/syncLeague');

const years = process.argv.slice(2).map(Number).filter(Boolean);
if (!years.length) years.push(2023, 2024, 2025, 2026);
const PAUSE_MS = 20_000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let first = true;
  for (const year of years) {
    for (const slug of Object.keys(FD_COMP)) {
      if (!first) await sleep(PAUSE_MS);
      first = false;
      try {
        const r = await syncLeagueSeason(slug, year);
        console.log(`ok   ${slug} ${year}: ${r.teams} teams`);
      } catch (e) {
        console.error(`FAIL ${slug} ${year}: ${e.message}`);
      }
    }
  }
})();
