const mongoose = require("mongoose");

// Upcoming (Spotify pre-release) and just-released records for the tracked
// artists, refreshed after each daily cron run by services/releases.js.
const releaseSchema = new mongoose.Schema({
    releaseKey: { type: String, required: true }, // Spotify album id, or "prerelease:<id>" until one exists
    albumId: { type: String },
    artistSpotifyId: { type: String, required: true },
    artistName: { type: String },
    artistImage: { type: String },
    name: { type: String, required: true },
    type: { type: String }, // ALBUM, SINGLE, EP, ...
    coverUrl: { type: String },
    releaseDate: { type: Date, required: true },
    source: { type: String, enum: ["preRelease", "latest"] },
}, { timestamps: true });

releaseSchema.index({ releaseKey: 1 }, { unique: true });
releaseSchema.index({ releaseDate: 1 });

const Release = mongoose.models.releases || mongoose.model("releases", releaseSchema);

module.exports = Release;
