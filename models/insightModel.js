const mongoose = require("mongoose");

// One precomputed snapshot per song / album / artist, rebuilt after every
// daily cron run by services/insights.js. Feature routes (milestones, share
// cards, ...) read these instead of crunching the daily history per request.
const insightSchema = new mongoose.Schema({
    type: { type: String, enum: ["song", "album", "artist"], required: true },
    spotifyId: { type: String, required: true },
    name: { type: String },
    image: { type: String },
    artistSpotifyId: { type: String },
    artistName: { type: String },
    releaseDate: { type: String },
    total: { type: Number },
    // total before the latest computed day; lets a same-day re-run detect the same crossings
    prevTotal: { type: Number },
    daily: { type: Number },
    dailyChangePct: { type: Number },
    avg7: { type: Number },
    nextMilestone: { type: Number },
    major: { type: Boolean },
    etaDays: { type: Number },
    etaDate: { type: Date },
    // the data day these numbers describe ("DD-MM-YYYY") and its Date form
    dateKey: { type: String },
    date: { type: Date },
    // true when the item has no data for the latest day (dropped off kworb)
    stale: { type: Boolean, default: false },
    historyDays: { type: Number },
}, { timestamps: true });

insightSchema.index({ type: 1, spotifyId: 1 }, { unique: true });
insightSchema.index({ type: 1, stale: 1, etaDays: 1 });
insightSchema.index({ type: 1, stale: 1, total: 1 });

const Insight = mongoose.models.insights || mongoose.model("insights", insightSchema);

module.exports = Insight;
