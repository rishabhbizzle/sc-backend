
require('dotenv').config();
const express = require('express');
const { getArtistSongsDailyData, getArtistMostPopularSongs, getArtistSpotifyApiData, getArtistAlbumsDailyData, getArtistOverallDailyData, getTrackData, getAlbumData, getNewReleases, isUserFavorite, getRecomendations, getArtistStreamingData, getDashboardArtistRankingData, getUserFavourites, getMostStreamedArtists, getMostMonthlyListeners, getMostStreamedSongs, getMostStreamedAlbums, markFavourite, getMostStreamedSongsInSingleDay, getMostStreamedSongsInSingleWeek, getMostStreamedAlbumInSingle, getArtistSocialData, getLastFmTopTracks, getTopTracksBasedOnCharts, getQQMusicTopTracks, getTopViralTracks, getMostViewedYTVideos, searchService } = require('./services');
// Deliberately not `PORT`: the droplet's .env sets PORT for something else and
// nginx proxies to 4000. API_PORT exists so tests can run instances side by side.
const port = parseInt(process.env.API_PORT, 10) > 0 ? parseInt(process.env.API_PORT, 10) : 4000;
const cors = require('cors');
const app = express();
const mongoose = require('mongoose');
const { rateLimitMiddleware, heavyRateLimitMiddleware } = require('./utilities/rateLimiter');
const browserPool = require('./utilities/browser');
const { closeBrowser } = browserPool;
const httpClient = require('./utilities/http');
const { positiveIntEnv } = require('./utilities/semaphore');
const cronController = require('./cron/controller');
const { WikipediaLayoutError } = require('./scrapers/wikipedia');
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


// If this service runs behind a reverse proxy / CDN (Vercel, Render, Nginx, Cloudflare),
// enable `trust proxy` so `req.ip` reflects the real client IP (needed for rate limiting).
app.set('trust proxy', 1);

app.use(express.json());
app.use(cors({
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    origin: ['http://localhost:3000', 'https://spotracker.tech', 'https://www.spotracker.tech', 'https://statscrave.com', 'https://www.statscrave.com', 'https://statforfans.netlify.app', 'https://www.statforfans.netlify.app', 'https://statscrave-git-feat-theme-bizzxles-projects.vercel.app', 'https://statscrave-git-development-bizzxles-projects.vercel.app', 'statscrave-production.up.railway.app', 'https://statscrave-production.up.railway.app']
}))

app.use(rateLimitMiddleware);

// Backstop: no request may sit open longer than the reverse proxy will wait
// (nginx gives up at 120s). Scrapes finish in seconds now; this only catches
// something unexpected and turns it into a clear 503 instead of a silent 504.
const REQUEST_TIMEOUT_MS = positiveIntEnv(process.env.REQUEST_TIMEOUT_MS, 100000);
app.use((req, res, next) => {
    res.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (!res.headersSent) {
            res.status(503).json({ status: 'error', message: `Request timed out after ${REQUEST_TIMEOUT_MS}ms` });
        }
    });
    next();
});

async function connect() {
    try {
        mongoose.connect(process.env.MONGO_URI, {
            dbName: 'prod',
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 15000,
        }).catch((err) => {
            console.error('MongoDB initial connection failed:', err?.message);
        });
        const connection = mongoose.connection;
        let everConnected = false;
        connection.on('connected', () => {
            everConnected = true;
            console.log('MongoDB connected successfully');
        })

        connection.on('error', (err) => {
            console.error('MongoDB connection error: ' + err);
            // Mongoose reconnects on its own once it has connected; only give up
            // (and let pm2 restart us) if the very first connection never happened.
            if (!everConnected) process.exit(1);
        })

    } catch (error) {
        console.log('Something goes wrong!');
        console.log(error);
    }
}

connect();
const client = new Redis(process.env.REDIS_URL, {
    // A stuck or quota-limited Redis must never hang a request: time commands
    // out quickly and treat any failure as a cache miss.
    connectTimeout: 10000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
})
    .on('connect', () => {
        console.log('Redis connected successfully');
    })
    .on('error', (err) => {
        console.error('Redis client error:', err?.message);
    });

app.get('/', (req, res) => {
    res.json({
        message: 'Welcome to Statscrave API!',
    });
});

cronController.start();

// Redis cache helpers. Any Redis problem is a cache miss, never an error.
const getCachedEntry = async (key) => {
    try {
        const raw = await client.get(key);
        if (raw === null || raw === undefined) return { found: false };
        return { found: true, value: JSON.parse(raw) };
    } catch (error) {
        console.error('Redis get failed:', error?.message);
        return { found: false };
    }
};

// Cache TTLs (seconds). Daily-scraped data refreshes a few times a day;
// leaderboards/records change slowly, so they live longer.
const FIVE_MINUTES = 5 * 60;
const ONE_HOUR = 60 * 60;
const SIX_HOURS = 6 * 60 * 60;
const TWELVE_HOURS = 12 * 60 * 60;

const setCachedData = (key, value, ttlSeconds) => {
    // fire-and-forget; never let a cache-write failure affect the response.
    // A TTL lets each key refresh on its own schedule instead of relying on a
    // daily flushall (which caused a thundering herd of scrapes right after it).
    const payload = JSON.stringify(value);
    const writePromise = ttlSeconds
        ? client.set(key, payload, 'EX', ttlSeconds)
        : client.set(key, payload);
    return writePromise.catch((err) => {
        console.error('Redis set failed:', err?.message);
    });
};

// Serve from cache, otherwise run `fetcher` and cache its result. Empty
// results (null / []) are cached for `negativeTtl` only, so a kworb 404 or a
// temporarily empty table does not stick for the full TTL.
const withCache = async (key, ttlSeconds, fetcher, { negativeTtl = FIVE_MINUTES } = {}) => {
    const cached = await getCachedEntry(key);
    if (cached.found) return cached.value;
    const value = await fetcher();
    const isEmpty = value == null || (Array.isArray(value) && value.length === 0);
    setCachedData(key, value, isEmpty ? negativeTtl : ttlSeconds);
    return value;
};

const sendJson = (res, status, body) => {
    if (res.headersSent) return;
    res.status(status).json(body);
};

// Maps scraper failures to honest status codes: 503 when the upstream site or
// the browser pool is busy/unavailable (nothing is cached, the client may
// retry), 502 when Wikipedia's layout changed and the parser needs attention.
const sendError = (res, error) => {
    const message = error?.message || 'Something went wrong';
    const name = error?.name;
    if (name === 'UpstreamUnavailableError' || name === 'SemaphoreTimeoutError' || name === 'BrowserTimeoutError') {
        console.warn('Upstream unavailable:', message);
        return sendJson(res, 503, { status: 'error', message: 'Upstream data source is temporarily unavailable, please retry shortly', detail: message });
    }
    if (error instanceof WikipediaLayoutError) {
        console.error('Wikipedia layout changed:', message);
        return sendJson(res, 502, { status: 'error', message: 'Records source layout changed; this list needs a parser update', detail: message });
    }
    console.error(error);
    return sendJson(res, 500, { status: 'error', message });
};


// ---------------------------------------------------------------------------
// kworb + Wikipedia routes. All of these fetch static HTML over plain HTTP
// (see scrapers/) and sit behind the Redis cache.
// ---------------------------------------------------------------------------
const cachedJsonRoute = (path, { key, ttl, negativeTtl, fetch, heavy = true }) => {
    const middlewares = heavy ? [heavyRateLimitMiddleware] : [];
    app.get(path, ...middlewares, async (req, res) => {
        try {
            const data = await withCache(key(req), ttl, () => fetch(req), { negativeTtl });
            return sendJson(res, 200, { status: 'success', data });
        } catch (error) {
            return sendError(res, error);
        }
    });
};

cachedJsonRoute('/api/v1/daily/songs/:id', { key: (r) => `daily-songs-${r.params.id}`, ttl: SIX_HOURS, fetch: (r) => getArtistSongsDailyData(r.params.id) });
cachedJsonRoute('/api/v1/daily/albums/:id', { key: (r) => `daily-albums-${r.params.id}`, ttl: SIX_HOURS, fetch: (r) => getArtistAlbumsDailyData(r.params.id) });
cachedJsonRoute('/api/v1/daily/overall/:id', { key: (r) => `daily-overall-${r.params.id}`, ttl: SIX_HOURS, fetch: (r) => getArtistOverallDailyData(r.params.id) });
// Social stats are null while the Chartmetric scrape is disabled (see services.js);
// the null is cached for an hour so the artist page never waits on it.
cachedJsonRoute('/api/v1/artist/social/:id', { key: (r) => `social-${r.params.id}`, ttl: TWELVE_HOURS, negativeTtl: ONE_HOUR, fetch: (r) => getArtistSocialData(r.params.id) });
// The leaderboards always return the top 100; honouring a `limit` query would
// let one caller poison the shared cache key with a shorter list.
cachedJsonRoute('/api/v1/others/mostStreamedArtists', { key: () => 'mostStreamedArtists', ttl: TWELVE_HOURS, fetch: () => getMostStreamedArtists() });
cachedJsonRoute('/api/v1/others/mostMonthlyListeners', { key: () => 'mostMonthlyListeners', ttl: TWELVE_HOURS, fetch: () => getMostMonthlyListeners() });
cachedJsonRoute('/api/v1/others/mostStreamedSongs', { key: (r) => `mostStreamedSongs-${r.query.year || 'all'}`, ttl: TWELVE_HOURS, fetch: (r) => getMostStreamedSongs(r.query.year) });
cachedJsonRoute('/api/v1/others/mostStreamedAlbums', { key: () => 'mostStreamedAlbums', ttl: TWELVE_HOURS, fetch: () => getMostStreamedAlbums() });
cachedJsonRoute('/api/v1/others/mostStreamedSongsInSingleDay', { key: (r) => `records-songs-day-${r.query.type === 'holiday' ? 'holiday' : 'all'}`, ttl: TWELVE_HOURS, fetch: (r) => getMostStreamedSongsInSingleDay(r.query.type) });
cachedJsonRoute('/api/v1/others/mostStreamedSongsInSingleWeek', { key: () => 'records-songs-week', ttl: TWELVE_HOURS, fetch: () => getMostStreamedSongsInSingleWeek() });
cachedJsonRoute('/api/v1/others/mostStreamedAlbumsInSingle', { key: (r) => `records-albums-${r.query.mode === 'week' ? 'week' : 'day'}`, ttl: TWELVE_HOURS, fetch: (r) => getMostStreamedAlbumInSingle(r.query.mode) });
cachedJsonRoute('/api/v1/youtube/mostViewedVideos', { key: (r) => `mostViewedVideosYT-${r.query.year || 'all'}`, ttl: TWELVE_HOURS, fetch: (r) => getMostViewedYTVideos(r.query.year) });


// ---------------------------------------------------------------------------
// Spotify / Last.fm / QQ Music routes. Cached for an hour so a Spotify rate
// limit or outage cannot take the landing page or an artist page down, and so
// a traffic spike does not turn into one Spotify call per visitor.
// ---------------------------------------------------------------------------
const q = (value, fallback) => (Array.isArray(value) ? value[0] : value) || fallback;
cachedJsonRoute('/api/v1/artist/popular/:id', { heavy: false, key: (r) => `artist-popular-${r.params.id}`, ttl: SIX_HOURS, fetch: (r) => getArtistMostPopularSongs(r.params.id) });
cachedJsonRoute('/api/v1/artist/:id', { heavy: false, key: (r) => `artist-meta-${r.params.id}`, ttl: ONE_HOUR, fetch: (r) => getArtistSpotifyApiData(r.params.id) });
cachedJsonRoute('/api/v1/others/new-releases', { heavy: false, key: (r) => `new-releases-${q(r.query.limit, 50)}`, ttl: ONE_HOUR, fetch: (r) => getNewReleases(q(r.query.limit, undefined)) });
cachedJsonRoute('/api/v1/songs/top', { heavy: false, key: (r) => `songs-top-${q(r.query.country, 'global')}-${q(r.query.limit, 50)}`, ttl: ONE_HOUR, fetch: (r) => getTopTracksBasedOnCharts(q(r.query.country, undefined), q(r.query.limit, undefined)) });
cachedJsonRoute('/api/v1/songs/viral', { heavy: false, key: (r) => `songs-viral-${q(r.query.limit, 50)}`, ttl: ONE_HOUR, fetch: (r) => getTopViralTracks(q(r.query.limit, undefined)) });
cachedJsonRoute('/api/v1/charts/lastFmTopTracks', { heavy: false, key: (r) => `lastfm-top-${q(r.query.page, 1)}-${q(r.query.limit, 10)}`, ttl: ONE_HOUR, fetch: (r) => getLastFmTopTracks(q(r.query.page, undefined), q(r.query.limit, undefined)) });
cachedJsonRoute('/api/v1/charts/qqMusic', { heavy: false, key: (r) => `qq-top-${q(r.query.limit, 100)}`, ttl: ONE_HOUR, fetch: (r) => getQQMusicTopTracks(q(r.query.limit, undefined)) });

// Liveness + a quick look at the moving parts (pool/queue sizes, cron state).
app.get('/api/v1/health', (req, res) => {
    const mongoState = mongoose.STATES[mongoose.connection.readyState] || String(mongoose.connection.readyState);
    const body = {
        status: mongoState === 'connected' ? 'ok' : 'degraded',
        uptimeSeconds: Math.round(process.uptime()),
        mongo: mongoState,
        redis: client.status,
        http: httpClient.stats(),
        browser: browserPool.stats(),
        cron: cronController.status(),
    };
    res.status(body.status === 'ok' ? 200 : 503).json(body);
});


//spotify

//spotify

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


const server = app.listen(port, () => console.log(`App listening on port ${port}!`));

// Graceful shutdown: close the shared Chromium so its child processes don't
// orphan and pin memory across restarts, then drain Redis and Mongo.
async function shutdown(signal) {
    console.log(`Received ${signal}, shutting down gracefully...`);
    // Hard-exit if cleanup hangs so the process never gets stuck on restart.
    setTimeout(() => process.exit(1), 10000).unref();
    try { server.close(); } catch (_) { /* ignore */ }
    try { await closeBrowser(); } catch (_) { /* ignore */ }
    try { await client.quit(); } catch (_) { /* ignore */ }
    try { await mongoose.connection.close(); } catch (_) { /* ignore */ }
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
// A rejected promise nobody awaited (e.g. a late cache write) must not take
// the whole API down with it; log it and keep serving.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});
process.on('SIGINT', () => shutdown('SIGINT'));