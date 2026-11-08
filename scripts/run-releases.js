'use strict';
// Refreshes release countdowns / just-released records once and exits (the
// daily cron already does this). Writes only the `releases` collection.
//   node scripts/run-releases.js
require('dotenv').config();
const mongoose = require('mongoose');
const { refreshReleases } = require('../services/releases');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME || 'prod', serverSelectionTimeoutMS: 15000 });
    const result = await refreshReleases();
    console.log(JSON.stringify(result, null, 2));
    await mongoose.disconnect();
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
