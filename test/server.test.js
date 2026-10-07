'use strict';
// End-to-end test of the Express layer: spawns server.js against a mock
// upstream (serving the fixtures with scripted failure modes), an in-memory
// MongoDB and a dead Redis, then drives every route including the failure
// paths (upstream 500/404/hang, queue saturation, request-timeout backstop,
// auth/validation, rate limiting, graceful shutdown).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const { fixture, sleep } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const ID = (prefix) => (prefix + 'x'.repeat(22)).slice(0, 22); // 22-char ids encode a behaviour
const NORMAL = '06HL4z0CvFAxyc27GXpf02';
const sleepMsOf = (id) => parseInt((/^SLOW(\d+)/.exec(id) || [])[1] || '0', 10);

function freePort() {
    return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// --- mock upstream (kworb + Wikipedia) --------------------------------------
const hits = {};
const flaky = {};
let wikiBroken = false;
function mockUpstream() {
    return http.createServer(async (req, res) => {
        const url = req.url;
        if (url.startsWith('/__stats')) return res.end(JSON.stringify(hits));
        if (url.startsWith('/__wiki')) { wikiBroken = /broken=1/.test(url); return res.end('ok'); }
        hits[url] = (hits[url] || 0) + 1;
        const artist = /^\/spotify\/artist\/([^_]+)_(songs|albums)\.html$/.exec(url);
        if (artist) {
            const [, id, kind] = artist;
            if (id.startsWith('HANG')) return; // never answers
            if (id.startsWith('SLOW')) await sleep(sleepMsOf(id));
            if (id.startsWith('E500')) { res.statusCode = 500; return res.end('boom'); }
            if (id.startsWith('FLAKY')) { flaky[url] = (flaky[url] || 0) + 1; if (flaky[url] <= 2) { res.statusCode = 503; return res.end('busy'); } }
            if (id.startsWith('NOTFOUND')) { res.statusCode = 404; return res.end('nope'); }
            return res.end(fixture(kind === 'songs' ? 'kworb-artist-songs.html' : 'kworb-artist-albums.html'));
        }
        const map = {
            '/spotify/artists.html': 'kworb-artists.html', '/spotify/listeners.html': 'kworb-listeners.html',
            '/spotify/songs.html': 'kworb-songs.html', '/spotify/songs_2023.html': 'kworb-songs.html',
            '/spotify/albums.html': 'kworb-albums.html', '/youtube/topvideos.html': 'kworb-yt-topvideos.html', '/youtube/topvideos2023.html': 'kworb-yt-topvideos.html',
        };
        if (map[url]) return res.end(fixture(map[url]));
        if (url === '/wiki/records') return res.end(wikiBroken ? '<html><body><h2 id="Nothing_here">x</h2></body></html>' : fixture('wikipedia-spotify-records.html'));
        res.statusCode = 404; res.end('not found');
    });
}

let mongod; let upstream; let server; let base; let logs = '';
const api = (p, init) => fetch(base + p, init);
const json = async (p, init) => { const r = await api(p, init); const body = await r.json().catch(() => null); return { status: r.status, body, headers: r.headers }; };
const data = async (p) => { const r = await json(p); assert.equal(r.status, 200, `${p} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body.data; };

test.before(async () => {
    mongod = await MongoMemoryServer.create();
    upstream = mockUpstream();
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const mockBase = `http://127.0.0.1:${upstream.address().port}/`;
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            API_PORT: String(port),
            MONGO_URI: mongod.getUri(),
            REDIS_URL: 'redis://127.0.0.1:1', // nothing listens: every cache call must fail fast
            DATA_SOURCE: mockBase,
            WIKIPEDIA_RECORDS_URL: `${mockBase}wiki/records`,
            HTTP_TIMEOUT_MS: '3000', HTTP_RETRIES: '2', HTTP_MAX_CONCURRENCY: '2', HTTP_QUEUE_TIMEOUT_MS: '800',
            REQUEST_TIMEOUT_MS: '9000', HTTP_CIRCUIT_FAILURES: '1000',
            HEAVY_RATE_LIMIT_MAX: '60', RATE_LIMIT_MAX: '100000',
            SPOTIFY_CLIENT_ID: 'dummy', SPOTIFY_CLIENT_SECRET: 'dummy', LAST_FM_API_KEY: 'dummy', CLERK_SECRET_KEY: 'sk_test_dummy',
            CHARTMETRIC_SCRAPE_ENABLED: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => { logs += d; });
    server.stderr.on('data', (d) => { logs += d; });
    for (let i = 0; i < 60; i++) {
        try { const r = await fetch(`${base}/api/v1/health`); if (r.status === 200) return; } catch (_) { /* not up yet */ }
        await sleep(250);
    }
    throw new Error(`server did not become healthy:\n${logs.slice(-3000)}`);
});

test.after(async () => {
    if (server && server.exitCode === null) server.kill('SIGKILL');
    upstream.close();
    await mongod.stop();
});

test('health reports mongo up, redis down, cron scheduled', async () => {
    const { body } = await json('/api/v1/health');
    assert.equal(body.status, 'ok');
    assert.equal(body.mongo, 'connected');
    assert.notEqual(body.redis, 'ready');
    assert.equal(body.cron.schedule, '22 02 * * *');
    assert.equal(body.browser.browserLaunched, false);
});

test('artist daily routes keep their shapes (with the cache unavailable)', async () => {
    const songs = await data(`/api/v1/daily/songs/${NORMAL}`);
    assert.equal(songs.length, 30);
    assert.deepEqual(Object.keys(songs[0]), ['id', 'title', 'link', 'total', 'daily']);
    const albums = await data(`/api/v1/daily/albums/${NORMAL}`);
    assert.equal(albums.length, 30);
    const overall = await data(`/api/v1/daily/overall/${NORMAL}`);
    assert.deepEqual(overall.map((r) => r.type), ['Streams', 'Daily', 'Tracks']);
});

test('invalid ids are rejected without an upstream request; unknown artists give []', async () => {
    const before = JSON.stringify(hits);
    assert.deepEqual(await data('/api/v1/daily/songs/not-a-spotify-id'), []);
    assert.deepEqual(await data('/api/v1/daily/albums/..%2F..%2Fetc'), []);
    assert.equal(JSON.stringify(hits), before, 'no upstream hit for invalid ids');
    assert.deepEqual(await data(`/api/v1/daily/songs/${ID('NOTFOUND')}`), []);
    assert.deepEqual(await data(`/api/v1/daily/overall/${ID('NOTFOUND')}`), []);
});

test('upstream 500 is retried then answered as 503 (never 200 with empty data)', async () => {
    const id = ID('E500');
    const t0 = Date.now();
    const r = await json(`/api/v1/daily/songs/${id}`);
    assert.equal(r.status, 503);
    assert.match(r.body.message, /temporarily unavailable/);
    assert.match(r.body.detail, /HTTP 500/);
    assert.equal(hits[`/spotify/artist/${id}_songs.html`], 3, '1 try + 2 retries');
    assert.ok(Date.now() - t0 >= 2500, 'backed off between retries');
});

test('a flaky upstream recovers within the retry budget', async () => {
    const id = ID('FLAKY');
    const songs = await data(`/api/v1/daily/songs/${id}`);
    assert.equal(songs.length, 30);
    assert.equal(hits[`/spotify/artist/${id}_songs.html`], 3);
});

test('identical concurrent requests share one upstream fetch', async () => {
    const id = ID('SLOW1000');
    const results = await Promise.all(Array.from({ length: 10 }, () => json(`/api/v1/daily/songs/${id}`)));
    assert.ok(results.every((r) => r.status === 200 && r.body.data.length === 30));
    assert.equal(hits[`/spotify/artist/${id}_songs.html`], 1);
});

test('a saturated fetch pool fails callers fast instead of queueing them forever', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => ID(`SLOW1500A${i}`)); // letter keeps the index out of the sleep duration
    const t0 = Date.now();
    const results = await Promise.all(ids.map((id) => json(`/api/v1/daily/overall/${id}`)));
    const ok = results.filter((r) => r.status === 200).length;
    const busy = results.filter((r) => r.status === 503 && /no free slot/.test(r.body.detail)).length;
    assert.equal(ok, 2, 'HTTP_MAX_CONCURRENCY=2 jobs ran');
    assert.equal(busy, 4, 'the rest were rejected after HTTP_QUEUE_TIMEOUT_MS');
    assert.ok(Date.now() - t0 < 4000);
    await sleep(2500); // let the two in-flight slow fetches finish so they do not skew the next test
});

test('an upstream that never answers hits the request-timeout backstop and the server stays healthy', async () => {
    const t0 = Date.now();
    const r = await json(`/api/v1/daily/albums/${ID('HANG')}`);
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 503);
    assert.match(r.body.message, /Request timed out after 9000ms/);
    assert.ok(elapsed >= 8500 && elapsed < 11000, `backstop fired at ${elapsed}ms`);
    // the handler is still finishing in the background; the process must not crash on "headers already sent"
    await sleep(4500);
    assert.equal(server.exitCode, null, `server died:\n${logs.slice(-2000)}`);
    assert.equal((await json('/api/v1/health')).status, 200);
    assert.equal((await data(`/api/v1/daily/songs/${NORMAL}`)).length, 30);
    assert.ok(!/Cannot set headers|ERR_HTTP_HEADERS_SENT/.test(logs), 'no headers-already-sent errors in the logs');
});

test('leaderboards, year pages and youtube', async () => {
    assert.equal((await data('/api/v1/others/mostStreamedArtists')).length, 30);
    assert.equal((await data('/api/v1/others/mostStreamedArtists?limit=5')).length, 30, 'limit is ignored so the shared cache key stays consistent');
    assert.equal((await data('/api/v1/others/mostMonthlyListeners')).length, 30);
    assert.equal((await data('/api/v1/others/mostStreamedSongs')).length, 30);
    assert.equal((await data('/api/v1/others/mostStreamedSongs?year=2023')).length, 30);
    assert.deepEqual(await data('/api/v1/others/mostStreamedSongs?year=1999'), [], 'kworb 404 for a year page -> []');
    const before = hits['/spotify/songs_abcd.html'] || 0;
    assert.deepEqual(await data('/api/v1/others/mostStreamedSongs?year=abcd'), []);
    assert.equal(hits['/spotify/songs_abcd.html'] || 0, before, 'junk year never reaches upstream');
    assert.equal((await data('/api/v1/others/mostStreamedAlbums')).length, 30);
    assert.equal((await data('/api/v1/youtube/mostViewedVideos')).length, 30);
    assert.equal((await data('/api/v1/youtube/mostViewedVideos?year=2023')).length, 30);
    assert.deepEqual(await data('/api/v1/youtube/mostViewedVideos?year=1999'), []);
});

test('wikipedia records routes, and a layout change surfaces as 502', async () => {
    const day = await data('/api/v1/others/mostStreamedSongsInSingleDay');
    const holiday = await data('/api/v1/others/mostStreamedSongsInSingleDay?type=holiday');
    assert.ok(day.length >= 10 && holiday.length >= 10 && day[0].name !== holiday[0].name);
    assert.ok((await data('/api/v1/others/mostStreamedSongsInSingleWeek')).length >= 10);
    const albumsDay = await data('/api/v1/others/mostStreamedAlbumsInSingle?mode=day');
    const albumsWeek = await data('/api/v1/others/mostStreamedAlbumsInSingle?mode=week');
    assert.ok(albumsDay.length >= 10 && albumsWeek.length >= 10 && albumsDay[0].streams !== albumsWeek[0].streams);
    assert.deepEqual(Object.keys(albumsDay[0]), ['name', 'artist', 'streams', 'dateAchieved', 'tracks', 'average']);
    assert.equal((await data('/api/v1/others/mostStreamedAlbumsInSingle?mode=garbage')).length, albumsDay.length, 'unknown mode falls back to day');
    await fetch(`http://127.0.0.1:${upstream.address().port}/__wiki?broken=1`);
    const r = await json('/api/v1/others/mostStreamedSongsInSingleWeek');
    assert.equal(r.status, 502);
    assert.match(r.body.message, /layout changed/);
    await fetch(`http://127.0.0.1:${upstream.address().port}/__wiki?broken=0`);
    assert.ok((await data('/api/v1/others/mostStreamedSongsInSingleWeek')).length >= 10);
});

test('social stats are null (Chartmetric scrape disabled) and nothing touches the browser pool', async () => {
    assert.equal(await data(`/api/v1/artist/social/${NORMAL}`), null);
    assert.equal((await json('/api/v1/health')).body.browser.browserLaunched, false);
});

test('favourites flow: mark, check, list, dashboard, unmark, and the 5-artist cap', async () => {
    const user = 'integration-user';
    const post = (p, body) => json(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/v1/user/markFavourite', {})).status, 400, 'missing fields');
    assert.equal((await post('/api/v1/user/isFavourite', {})).body.status, 'error');
    const added = await post('/api/v1/user/markFavourite', { id: user, type: 'artist', spotifyId: NORMAL, image: 'img', name: 'Taylor Swift' });
    assert.equal(added.status, 200);
    assert.match(added.body.data.message, /Added/);
    assert.equal((await post('/api/v1/user/isFavourite', { id: user, type: 'artist', spotifyId: NORMAL })).body.data, true);
    const favs = await data(`/api/v1/user/favourites/${user}`);
    assert.equal(favs.artistFavourites.length, 1);
    const dashboard = await data(`/api/v1/user/dashboard/${user}`);
    assert.equal(dashboard.length, 1);
    assert.equal(dashboard[0].spotifyId, NORMAL);
    assert.match(dashboard[0].streams, /^\d[\d,]*$/, 'streams come from the kworb overall table when the artist is not in Mongo');
    assert.match(dashboard[0].dailyStreams, /^\d[\d,]*$/);
    for (let i = 0; i < 4; i++) {
        const r = await post('/api/v1/user/markFavourite', { id: user, type: 'artist', spotifyId: ID(`SLOW0${i}`), image: 'img', name: `a${i}` });
        assert.equal(r.status, 200);
    }
    const sixth = await post('/api/v1/user/markFavourite', { id: user, type: 'artist', spotifyId: ID('SLOW05'), image: 'img', name: 'a5' });
    assert.equal(sixth.status, 500);
    assert.match(sixth.body.message, /upto 5/);
    const removed = await post('/api/v1/user/markFavourite', { id: user, type: 'artist', spotifyId: NORMAL, image: 'img', name: 'Taylor Swift' });
    assert.match(removed.body.data.message, /Removed/);
    assert.equal((await post('/api/v1/user/isFavourite', { id: user, type: 'artist', spotifyId: NORMAL })).body.data, false);
    assert.equal((await data('/api/v1/user/dashboard/nobody')).length, 0);
});

test('mongo-only routes with an empty database', async () => {
    assert.equal(await data(`/api/v1/artist/streams/${NORMAL}`), null);
    assert.deepEqual(await data('/api/v1/others/getRecomendations?type=artist'), []);
    const reviews = await json(`/api/v1/reviews?targetId=${NORMAL}`);
    assert.equal(reviews.status, 200);
    assert.equal(reviews.body.success, true);
    assert.equal((await json('/api/v1/reviews')).status, 400, 'missing targetId');
});

test('review routes require a Clerk token', async () => {
    const post = (p, body, headers = {}) => json(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/v1/reviews', { targetId: NORMAL, targetType: 'artist', rating: 5 })).status, 401);
    assert.equal((await post('/api/v1/reviews', { targetId: NORMAL, targetType: 'artist', rating: 5 }, { authorization: 'Bearer not-a-token' })).status, 401);
    assert.equal((await post('/api/v1/reviews/000000000000000000000000/like', {})).status, 401);
    assert.equal((await json('/api/v1/reviews/user?targetId=x')).status, 401);
    assert.equal((await json('/api/v1/reviews/000000000000000000000000', { method: 'DELETE' })).status, 401);
});

test('spotify-backed routes answer with a JSON error (not a hang) when Spotify rejects the credentials', async () => {
    for (const p of ['/api/v1/songs/top?limit=5', '/api/v1/others/new-releases?limit=5', '/api/v1/songs/viral']) {
        const t0 = Date.now();
        const r = await json(p);
        assert.ok([500, 503].includes(r.status), `${p} -> ${r.status}`);
        assert.equal(r.body.status, 'error');
        assert.ok(Date.now() - t0 < 15000);
    }
    // popular tracks degrade to an empty list (pre-existing behaviour), cached only briefly
    assert.deepEqual(await data('/api/v1/artist/popular/' + NORMAL), []);
    assert.equal((await json('/api/v1/health')).status, 200);
});

test('404 handler, CORS allow-list, rate-limit headers', async () => {
    const nf = await json('/api/v1/does-not-exist');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.message, 'Not Found');
    const allowed = await api('/', { headers: { origin: 'https://statscrave.com' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://statscrave.com');
    const denied = await api('/', { headers: { origin: 'https://evil.example' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const preflight = await api('/api/v1/user/markFavourite', { method: 'OPTIONS', headers: { origin: 'https://www.statscrave.com', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://www.statscrave.com');
    assert.ok(allowed.headers.get('ratelimit-limit'));
});

test('heavy routes are rate limited per IP (runs last: it spends the budget)', async () => {
    const results = await Promise.all(Array.from({ length: 70 }, () => json(`/api/v1/daily/overall/${NORMAL}`)));
    const limited = results.filter((r) => r.status === 429);
    assert.ok(limited.length >= 1 && limited.length <= 70, `${limited.length} limited`);
    assert.equal(limited[0].body.status, 'error');
    assert.match(limited[0].body.message, /heavy/);
    assert.ok(results.some((r) => r.status === 200));
});

test('SIGTERM shuts the server down cleanly', async () => {
    const t0 = Date.now();
    const exit = new Promise((resolve) => server.once('exit', (code) => resolve(code)));
    server.kill('SIGTERM');
    const code = await Promise.race([exit, sleep(12000).then(() => 'timeout')]);
    assert.equal(code, 0, `exit code ${code}; logs:\n${logs.slice(-1500)}`);
    assert.ok(Date.now() - t0 < 11000);
    assert.match(logs, /shutting down gracefully/);
});
