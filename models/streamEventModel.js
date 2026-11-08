const mongoose = require("mongoose");

// Things worth telling fans about, detected by services/insights.js:
//   milestone - total crossed `value` (e.g. 3,000,000,000)
//   record    - `value` is the item's highest daily count we have on record
// Unique per (type, spotifyId, kind, value) so re-runs never duplicate.
const streamEventSchema = new mongoose.Schema({
    type: { type: String, enum: ["song", "album", "artist"], required: true },
    spotifyId: { type: String, required: true },
    kind: { type: String, enum: ["milestone", "record"], required: true },
    value: { type: Number, required: true },
    major: { type: Boolean, default: false },
    dateKey: { type: String, required: true },
    date: { type: Date, required: true },
    name: { type: String },
    image: { type: String },
    artistSpotifyId: { type: String },
    artistName: { type: String },
}, { timestamps: true });

streamEventSchema.index({ type: 1, spotifyId: 1, kind: 1, value: 1 }, { unique: true });
streamEventSchema.index({ kind: 1, date: -1 });

const StreamEvent = mongoose.models.streamEvents || mongoose.model("streamEvents", streamEventSchema);

module.exports = StreamEvent;
