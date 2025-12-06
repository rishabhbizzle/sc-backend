/**
 * Review Services - Business logic for review feature
 */

const Review = require('../models/reviewModel');
const { createClerkClient } = require('@clerk/clerk-sdk-node');

// Initialize Clerk client for user data enrichment
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

/**
 * Create or update a review (upsert)
 * @param {string} userId - Clerk user ID
 * @param {string} targetId - Album or song Spotify ID
 * @param {string} targetType - 'album' or 'song'
 * @param {number} rating - Rating 1-5
 * @param {string} reviewText - Optional review text
 * @returns {Object} Created/updated review
 */
const createOrUpdateReview = async (userId, targetId, targetType, rating, reviewText) => {
    const review = await Review.findOneAndUpdate(
        { userId, targetId },
        {
            userId,
            targetId,
            targetType,
            rating,
            reviewText: reviewText || '',
        },
        { new: true, upsert: true, runValidators: true }
    );
    return review;
};

/**
 * Get reviews for a target with stats and pagination
 * @param {string} targetId - Album or song Spotify ID
 * @param {number} page - Page number (1-indexed)
 * @param {number} limit - Items per page
 * @param {string} sort - 'newest' or 'most_liked'
 * @returns {Object} { reviews, stats, pagination }
 */
const getReviewsWithStats = async (targetId, page = 1, limit = 25, sort = 'newest') => {
    const skip = (page - 1) * limit;

    // Run stats and reviews queries in parallel for better performance
    const [statsAggregation, reviews] = await Promise.all([
        // Stats aggregation
        Review.aggregate([
            { $match: { targetId } },
            { $group: { _id: '$rating', count: { $sum: 1 } } }
        ]),
        // Paginated reviews with sorting
        Review.aggregate([
            { $match: { targetId } },
            { $addFields: { likesCount: { $size: { $ifNull: ['$likes', []] } } } },
            { $sort: sort === 'most_liked' ? { likesCount: -1, createdAt: -1 } : { createdAt: -1 } },
            { $skip: skip },
            { $limit: limit }
        ])
    ]);

    // Calculate stats
    const totalReviews = statsAggregation.reduce((acc, curr) => acc + curr.count, 0);
    const stats = {
        total: totalReviews,
        counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    };
    statsAggregation.forEach(item => {
        if (stats.counts[item._id] !== undefined) {
            stats.counts[item._id] = item.count;
        }
    });

    // Enrich with user data from Clerk
    const enrichedReviews = await enrichReviewsWithUserData(reviews);

    return {
        reviews: enrichedReviews,
        stats,
        pagination: {
            page,
            limit,
            hasMore: reviews.length === limit
        }
    };
};

/**
 * Enrich reviews with user data from Clerk
 * @param {Array} reviews - Array of review documents
 * @returns {Array} Reviews with user data
 */
const enrichReviewsWithUserData = async (reviews) => {
    if (!reviews || reviews.length === 0) return reviews;

    const userIds = [...new Set(reviews.map(r => r.userId))];
    let usersMap = {};

    if (userIds.length > 0) {
        try {
            const usersResponse = await clerkClient.users.getUserList({
                userId: userIds,
                limit: 100,
            });

            // Handle both array and paginated response formats
            const users = Array.isArray(usersResponse) ? usersResponse : (usersResponse?.data || []);
            users.forEach(user => {
                usersMap[user.id] = {
                    firstName: user.firstName,
                    lastName: user.lastName,
                    imageUrl: user.imageUrl,
                    username: user.username
                };
            });
        } catch (clerkError) {
            console.error('Error fetching users from Clerk:', clerkError);
        }
    }

    return reviews.map(review => ({
        ...review,
        user: usersMap[review.userId] || { firstName: 'Unknown', imageUrl: '' }
    }));
};

/**
 * Toggle like on a review
 * @param {string} reviewId - MongoDB ObjectId of review
 * @param {string} userId - Clerk user ID
 * @returns {Object} { likes, isLiked }
 */
const toggleReviewLike = async (reviewId, userId) => {
    const review = await Review.findById(reviewId);
    if (!review) {
        return null;
    }

    const isCurrentlyLiked = review.likes.includes(userId);

    if (isCurrentlyLiked) {
        // Use $pull for atomic unlike operation
        await Review.updateOne(
            { _id: reviewId },
            { $pull: { likes: userId } }
        );
    } else {
        // Use $addToSet to prevent duplicates
        await Review.updateOne(
            { _id: reviewId },
            { $addToSet: { likes: userId } }
        );
    }

    // Fetch updated review
    const updatedReview = await Review.findById(reviewId);

    return {
        likes: updatedReview.likes,
        isLiked: !isCurrentlyLiked
    };
};

/**
 * Get user's review for a specific target
 * @param {string} userId - Clerk user ID
 * @param {string} targetId - Album or song Spotify ID
 * @returns {Object|null} User's review or null
 */
const getUserReviewForTarget = async (userId, targetId) => {
    const review = await Review.findOne({ userId, targetId });
    return review;
};

/**
 * Delete a review (only if user owns it)
 * @param {string} reviewId - MongoDB ObjectId of review
 * @param {string} userId - Clerk user ID
 * @returns {Object} { found, authorized, success }
 */
const deleteReview = async (reviewId, userId) => {
    const review = await Review.findById(reviewId);
    if (!review) {
        return { found: false };
    }
    if (review.userId !== userId) {
        return { found: true, authorized: false };
    }
    await Review.deleteOne({ _id: reviewId });
    return { found: true, authorized: true, success: true };
};

/**
 * Validate MongoDB ObjectId format
 * @param {string} id - ID to validate
 * @returns {boolean} True if valid ObjectId
 */
const isValidObjectId = (id) => {
    return id && /^[0-9a-fA-F]{24}$/.test(id);
};

module.exports = {
    createOrUpdateReview,
    getReviewsWithStats,
    toggleReviewLike,
    getUserReviewForTarget,
    deleteReview,
    isValidObjectId,
    enrichReviewsWithUserData
};
