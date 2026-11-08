const mongoose = require("mongoose");

// A signed-in player's Streamdle result for one day (first submission wins).
const gameResultSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    gameDate: { type: String, required: true },
    picks: [{ type: String, enum: ["a", "b"] }],
    results: [Boolean],
    score: { type: Number, required: true },
}, { timestamps: true });

gameResultSchema.index({ userId: 1, gameDate: 1 }, { unique: true });

const GameResult = mongoose.models.gameResults || mongoose.model("gameResults", gameResultSchema);

module.exports = GameResult;
