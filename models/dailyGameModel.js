const mongoose = require("mongoose");

// One Streamdle puzzle per UTC day. Totals are frozen when the puzzle is made
// so answers can't shift mid-day as the numbers update.
const sideSchema = new mongoose.Schema({
    spotifyId: String,
    name: String,
    artistName: String,
    image: String,
    total: Number,
}, { _id: false });

const dailyGameSchema = new mongoose.Schema({
    gameDate: { type: String, required: true }, // "YYYY-MM-DD" (UTC)
    number: { type: Number, required: true },
    rounds: [{ a: sideSchema, b: sideSchema, _id: false }],
}, { timestamps: true });

dailyGameSchema.index({ gameDate: 1 }, { unique: true });

const DailyGame = mongoose.models.dailyGames || mongoose.model("dailyGames", dailyGameSchema);

module.exports = DailyGame;
