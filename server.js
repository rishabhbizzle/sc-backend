
require('dotenv').config();
const express = require('express');
const { getArtistSongsDailyData, getArtistMostPopularSongs, getArtistSpotifyApiData, getArtistAlbumsDailyData, getArtistOverallDailyData, getTrackData, getAlbumData, getNewReleases, isUserFavorite, getRecomendations, getArtistStreamingData, getDashboardArtistRankingData, getUserFavourites, getMostStreamedArtists, getMostMonthlyListeners, getMostStreamedSongs, getMostStreamedAlbums, markFavourite, getMostStreamedSongsInSingleDay, getMostStreamedSongsInSingleWeek, getMostStreamedAlbumInSingle, getArtistSocialData, getLastFmTopTracks, getTopTracksBasedOnCharts, getQQMusicTopTracks, getTopViralTracks, getMostViewedYTVideos, searchService } = require('./services');
const port = 4000;
const cors = require('cors');
const app = express();
const mongoose = require('mongoose');
const rateLimitMiddleware = require('./utilities/rateLimiter');
const { Redis } = require("ioredis");
const { createClerkClient } = require('@clerk/clerk-sdk-node');
const {
    createOrUpdateReview,
    getReviewsWithStats,
    toggleReviewLike,
    getUserReviewForTarget,
    deleteReview,
    isValidObjectId
} = require('./services/reviewServices');

// Initialize Clerk client
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
console.log('Clerk client initialized, Secret Key Present:', !!process.env.CLERK_SECRET_KEY, process.env.CLERK_SECRET_KEY);

const verifyClerkToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ status: 'error', message: 'No token provided' });
        }

        const token = authHeader.split(' ')[1];
        const payload = await clerkClient.verifyToken(token);

        if (!payload || !payload.sub) {
            return res.status(401).json({ status: 'error', message: 'Invalid token' });
        }

        req.userId = payload.sub;
        next();
    } catch (error) {
        console.error('Token verification error:', error);
        return res.status(401).json({ status: 'error', message: 'Token verification failed' });
    }
};


app.use(express.json());
app.use(cors({
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    origin: ['http://localhost:3000', 'https://spotracker.tech', 'https://www.spotracker.tech', 'https://statscrave.com', 'https://www.statscrave.com', 'https://statforfans.netlify.app', 'https://www.statforfans.netlify.app', 'https://statscrave-git-feat-theme-bizzxles-projects.vercel.app', 'https://statscrave-git-development-bizzxles-projects.vercel.app']
}))

app.use(rateLimitMiddleware);

async function connect() {
    try {
        mongoose.connect(process.env.MONGO_URI, {
            dbName: 'prod',
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        const connection = mongoose.connection;
        connection.on('connected', () => {
            console.log('MongoDB connected successfully');
        })

        connection.on('error', (err) => {
            console.log('MongoDB connection error. Please make sure MongoDB is running. ' + err);
            process.exit();
        })

    } catch (error) {
        console.log('Something goes wrong!');
        console.log(error);
    }
}

connect();
console.log('REDIS_URL', process.env.REDIS_URL);
const client = new Redis(process.env.REDIS_URL).on('connect', () => {
    console.log('Redis connected successfully');
})

app.get('/', (req, res) => {
    res.json({
        message: 'Welcome to Statscrave API!',
    });
});

require('./cron/controller');

const getCachedData = (key) => {
    return new Promise((resolve, reject) => {
        try {
            client.get(key, (err, data) => {
                if (err) {
                    return reject(err);
                }
                if (data !== null) {
                    return resolve(JSON.parse(data));
                } else {
                    // If data is null, resolve with null
                    return resolve(null);
                }
            });
        } catch (error) {
            // Handle synchronous errors within the try block
            console.error(error);
            reject(error); // Reject the Promise
        }
    });
}


//kworb
app.get('/api/v1/daily/songs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cacheData = await getCachedData(`daily-songs-${id}`);
        if (cacheData) {
            return res.status(200).json({ status: 'success', data: cacheData });
        }
        const artistData = await getArtistSongsDailyData(id);
        client.set(`daily-songs-${id}`, JSON.stringify(artistData));
        return res.status(200).json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/daily/albums/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cacheData = await getCachedData(`daily-albums-${id}`);
        if (cacheData) {
            console.log('cacheData', cacheData);
            return res.status(200).json({ status: 'success', data: cacheData });
        }
        const artistData = await getArtistAlbumsDailyData(id);
        client.set(`daily-albums-${id}`, JSON.stringify(artistData));
        return res.status(200).json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});

app.get('/api/v1/daily/overall/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cacheData = await getCachedData(`daily-overall-${id}`);
        if (cacheData) {
            console.log('cacheData', cacheData);
            return res.status(200).json({ status: 'success', data: cacheData });
        }
        const artistData = await getArtistOverallDailyData(id);
        client.set(`daily-overall-${id}`, JSON.stringify(artistData));
        return res.status(200).json({ status: 'success', data: artistData });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});


//spotify
app.get('/api/v1/artist/popular/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getArtistMostPopularSongs(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

//spotify
app.get('/api/v1/artist/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getArtistSpotifyApiData(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/artist/streams/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getArtistStreamingData(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/artist/social/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cacheData = await getCachedData(`social-${id}`);
        if (cacheData) {
            return res.status(200).json({ status: 'success', data: cacheData });
        }
        const data = await getArtistSocialData(id);
        client.set(`social-${id}`, JSON.stringify(data));
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});

app.get('/api/v1/track/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { metaData } = req.query;
        const data = await getTrackData(id, metaData);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/album/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { metaData } = req.query;
        const data = await getAlbumData(id, metaData);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});


app.get('/api/v1/others/new-releases', async (req, res) => {
    try {
        const { limit } = req?.query;
        const data = await getNewReleases(limit);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.post('/api/v1/user/isFavourite', async (req, res) => {
    try {
        const { id, spotifyId, type } = req.body;
        if (!id || !spotifyId || !type) {
            return res.json({ status: 'error', message: 'Please provide all required fields' });
        }

        const data = await isUserFavorite(type, spotifyId, id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/user/dashboard/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.json({ status: 'error', message: 'Please provide all required fields' });
        }

        const data = await getDashboardArtistRankingData(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.post('/api/v1/user/markFavourite', async (req, res) => {
    try {
        const { id, type, spotifyId, image, name } = req.body;
        if (!id || !spotifyId || !type || !image || !name) {
            return res.status(400).json({ status: 'error', message: 'Please provide all required fields' });
        }

        const data = await markFavourite(id, type, spotifyId, image, name);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/user/favourites/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.json({ status: 'error', message: 'Please provide all required fields' });
        }

        const data = await getUserFavourites(id);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});


app.get('/api/v1/others/getRecomendations', async (req, res) => {
    try {
        const { type } = req.query;
        if (!type) {
            return res.json({ status: 'error', message: 'Please provide all required fields' });
        }
        const data = await getRecomendations(type);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedArtists', async (req, res) => {
    try {
        const { limit } = req.query;
        const cacheData = await getCachedData(`mostStreamedArtists`);
        if (cacheData) {
            return res.status(200).json({ status: 'success', data: cacheData });
        }
        const data = await getMostStreamedArtists(limit ? parseInt(limit) : 100);
        client.set(`mostStreamedArtists`, JSON.stringify(data));
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostMonthlyListeners', async (req, res) => {
    try {
        const { limit } = req?.query;
        const cacheData = await getCachedData(`mostMonthlyListeners`);
        if (cacheData) {
            return res.status(200).json({ status: 'success', data: cacheData });
        }
        const data = await getMostMonthlyListeners(limit ? parseInt(limit) : 100);
        client.set(`mostMonthlyListeners`, JSON.stringify(data));
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedSongs', async (req, res) => {
    try {
        const { year } = req?.query;
        const cacheData = await getCachedData(`mostStreamedSongs-${year}`);
        if (cacheData) {
            return res.status(200).json({ status: 'success', data: cacheData });
        }
        const data = await getMostStreamedSongs(year);
        client.set(`mostStreamedSongs-${year}`, JSON.stringify(data));
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedAlbums', async (req, res) => {
    try {
        const cacheData = await getCachedData(`mostStreamedAlbums`);
        if (cacheData) {
            return res.status(200).json({ status: 'success', data: cacheData });
        }
        const data = await getMostStreamedAlbums();
        client.set(`mostStreamedAlbums`, JSON.stringify(data));
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedSongsInSingleDay', async (req, res) => {
    try {
        const { type } = req?.query;
        const data = await getMostStreamedSongsInSingleDay(type);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedSongsInSingleWeek', async (req, res) => {
    try {
        const data = await getMostStreamedSongsInSingleWeek();
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

app.get('/api/v1/others/mostStreamedAlbumsInSingle', async (req, res) => {
    try {
        const { mode } = req?.query;
        const data = await getMostStreamedAlbumInSingle(mode);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});


app.get('/api/v1/charts/lastFmTopTracks', async (req, res) => {
    try {
        const { page, limit } = req?.query;
        const data = await getLastFmTopTracks(page, limit);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});

app.get('/api/v1/charts/qqMusic', async (req, res) => {
    try {
        const { limit } = req?.query;
        const data = await getQQMusicTopTracks(limit);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});



app.get('/api/v1/songs/top', async (req, res) => {
    try {
        const { country, limit } = req?.query;
        const data = await getTopTracksBasedOnCharts(country, limit);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});

app.get('/api/v1/songs/viral', async (req, res) => {
    try {
        const { limit } = req?.query;
        const data = await getTopViralTracks(limit);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});

app.get('/api/v1/songs/viral', async (req, res) => {
    try {
        const { limit } = req?.query;
        const data = await getTopViralTracks(limit);
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });
    }
});

app.get('/api/v1/youtube/mostViewedVideos', async (req, res) => {
    try {
        const { year } = req?.query;
        const cacheData = await getCachedData(`mostViewedVideosYT-${year}`);
        if (cacheData) {
            return res.status(200).json({ status: 'success', data: cacheData });
        }
        const data = await getMostViewedYTVideos(year);
        client.set(`mostViewedVideosYT-${year}`, JSON.stringify(data));
        return res.status(200).json({ status: 'success', data: data });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error?.message || 'Something went wrong' });

    }
});

function getRandomCharacter() {
    try {
        const charCode = Math.floor(Math.random() * 26) + 97;
        return String.fromCharCode(charCode)
    } catch (error) {
        return null
    }
}

app.get('/api/v1/search', async (req, res) => {
    try {
        let { text, type } = req.query;
        let searchText = text ? text : getRandomCharacter() || 'bieber'
        if (!searchText) {
            return res.status(400).json({ status: 'error', message: 'Please provide a search query' });
        }
        if (!type) {
            return res.status(400).json({ status: 'error', message: 'Please provide a type' });
        }
        const data = await searchService(searchText, type);
        return res.status(200).json({ status: 'success', success: true, data: { results: data } });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: error.message || 'Something went wrong' });
    }
});


// POST /api/v1/reviews - Create or update a review
app.post('/api/v1/reviews', verifyClerkToken, async (req, res) => {
    try {
        const { targetId, targetType, rating, reviewText } = req.body;

        if (!targetId || !targetType || !rating) {
            return res.status(400).json({ status: 'error', message: 'Missing required fields' });
        }

        const ratingNum = parseInt(rating);
        if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ status: 'error', message: 'Rating must be between 1 and 5' });
        }

        const review = await createOrUpdateReview(req.userId, targetId, targetType, ratingNum, reviewText);

        return res.status(200).json({
            message: 'Review submitted successfully',
            success: true,
            review,
        });
    } catch (error) {
        console.error('Error submitting review:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Something went wrong' });
    }
});

// GET /api/v1/reviews - Get reviews with stats
app.get('/api/v1/reviews', async (req, res) => {
    try {
        const { targetId, page = 1, limit = 25, sort = 'newest' } = req.query;

        if (!targetId) {
            return res.status(400).json({ status: 'error', message: 'Missing targetId' });
        }

        const result = await getReviewsWithStats(targetId, parseInt(page), parseInt(limit), sort);

        return res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching reviews:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Something went wrong' });
    }
});

// POST /api/v1/reviews/:reviewId/like - Toggle like on a review
app.post('/api/v1/reviews/:reviewId/like', verifyClerkToken, async (req, res) => {
    try {
        const { reviewId } = req.params;

        if (!isValidObjectId(reviewId)) {
            return res.status(400).json({ status: 'error', message: 'Invalid review ID' });
        }

        const result = await toggleReviewLike(reviewId, req.userId);

        if (!result) {
            return res.status(404).json({ status: 'error', message: 'Review not found' });
        }

        return res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error toggling like:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Something went wrong' });
    }
});

// GET /api/v1/reviews/user - Get current user's review for a target
app.get('/api/v1/reviews/user', verifyClerkToken, async (req, res) => {
    try {
        const { targetId } = req.query;

        if (!targetId) {
            return res.status(400).json({ status: 'error', message: 'Missing targetId' });
        }

        const review = await getUserReviewForTarget(req.userId, targetId);

        return res.status(200).json({
            success: true,
            review
        });
    } catch (error) {
        console.error('Error fetching user review:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Something went wrong' });
    }
});

// DELETE /api/v1/reviews/:reviewId - Delete a review (owner only)
app.delete('/api/v1/reviews/:reviewId', verifyClerkToken, async (req, res) => {
    try {
        const { reviewId } = req.params;

        if (!isValidObjectId(reviewId)) {
            return res.status(400).json({ status: 'error', message: 'Invalid review ID' });
        }

        const result = await deleteReview(reviewId, req.userId);

        if (!result.found) {
            return res.status(404).json({ status: 'error', message: 'Review not found' });
        }
        if (!result.authorized) {
            return res.status(403).json({ status: 'error', message: 'Not authorized to delete this review' });
        }

        return res.status(200).json({
            success: true,
            message: 'Review deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting review:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Something went wrong' });
    }
});

app.use('*', (req, res) => {
    res.status(404).json({
        message: 'Not Found',
    });
});


app.listen(port, () => console.log(`App listening on port ${port}!`));