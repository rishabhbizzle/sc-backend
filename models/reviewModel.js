const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: [true, "Please provide a user id"],
    },
    targetId: {
        type: String,
        required: [true, "Please provide a target id"],
    },
    targetType: {
        type: String,
        enum: ['album', 'song'],
        required: [true, "Please provide a target type"],
    },
    rating: {
        type: Number,
        min: 1,
        max: 5,
        required: [true, "Please provide a rating"],
    },
    reviewText: {
        type: String,
        trim: true,
        maxlength: [2000, "Review text cannot exceed 2000 characters"],
    },
    likes: {
        type: [String], // Array of userIds who liked the review
        default: [],
    },
}, {
    timestamps: true
});

// Compound index to ensure one review per user per target
reviewSchema.index({ userId: 1, targetId: 1 }, { unique: true });

const Review = mongoose.models.reviews || mongoose.model("reviews", reviewSchema);

module.exports = Review;
