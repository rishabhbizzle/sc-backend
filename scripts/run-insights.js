'use strict';
// Rebuilds the precomputed insights (milestones, ETAs, events) once and exits.
// The daily cron already does this after every run; use this to seed them
// right after deploying, or after a manual data fix.
//   node scripts/run-insights.js              # newest data day
//   node scripts/run-insights.js 05-11-2026   # a specific day key
// Writes to the `insights` and `streamEvents` collections only.
require('dotenv').config();
const mongoose = require('mongoose');
const { computeInsights } = require('../services/insights');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME || 'prod', serverSelectionTimeoutMS: 15000 });
    const result = await computeInsights({ asOfKey: process.argv[2] });
    console.log(JSON.stringify(result, null, 2));
    await mongoose.disconnect();
    process.exit(result.ok ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
