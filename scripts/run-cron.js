'use strict';
// Runs the daily kworb -> MongoDB sync once, outside the schedule, and exits.
//   node scripts/run-cron.js                 # all priority artists
//   node scripts/run-cron.js <spotifyId>...  # only these artists
// Safe to re-run: every write is an idempotent upsert keyed on the data day.
require('dotenv').config();
const mongoose = require('mongoose');
const { runDailyUpdate } = require('../cron/controller');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME || 'prod', serverSelectionTimeoutMS: 15000 });
    const artistIds = process.argv.slice(2);
    const delayMs = parseInt(process.env.CRON_ARTIST_DELAY_MS || '3000', 10);
    const { summary, results } = await runDailyUpdate({ artistIds: artistIds.length ? artistIds : undefined, delayMs });
    for (const r of results || []) {
        console.log(r.ok ? `ok   ${r.artistId} key=${r.dateKey} songs=${JSON.stringify(r.songs)} albums=${JSON.stringify(r.albums)}` : `FAIL ${r.artistId}: ${r.error}`);
    }
    console.log(JSON.stringify(summary, null, 2));
    await mongoose.disconnect();
    process.exit(summary && summary.failed && summary.failed.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
