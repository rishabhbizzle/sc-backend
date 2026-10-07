'use strict';

const cron = require('node-cron');
require('dotenv').config();
const { SpotifyApi } = require('@spotify/web-api-ts-sdk');
const Album = require('../models/albumModel');
const Song = require('../models/songModel');
const Artist = require('../models/artistModel');
const PriorityArtist = require('../models/priorityArtists');
const kworb = require('../scrapers/kworb');
const { positiveIntEnv, nonNegativeIntEnv } = require('../utilities/semaphore');

// Daily kworb -> MongoDB sync for the priority artists.
//
// Reliability changes versus the original cron:
//   - fetches the two kworb pages per artist over plain HTTP (no Chromium), so
//     a run is ~2 requests x 25 artists instead of 75 headless page loads that
//     queued behind user traffic in the shared browser pool for hours;
//   - every artist is retried a few times, and one failing artist (or one
//     failing song/album) never aborts the rest of the run;
//   - overlapping runs are skipped, so a slow run cannot stack on the next;
//   - daily keys are anchored on the date kworb prints on the page, so a run
//     that fires late (or is triggered by hand) still writes the right key;
//   - songs/albums are updated with one bulkWrite per artist using $set on the
//     dotted daily key instead of a read-modify-write per document.

const SCHEDULE = process.env.CRON_SCHEDULE || '22 02 * * *';
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';
const ARTIST_DELAY_MS = nonNegativeIntEnv(process.env.CRON_ARTIST_DELAY_MS, 10000);
const ARTIST_ATTEMPTS = positiveIntEnv(process.env.CRON_ARTIST_ATTEMPTS, 3);
const METADATA_BACKFILL_PER_ARTIST = 25;
// Gap between consecutive Spotify metadata lookups (one per NEW song/album), so a
// brand-new artist with 500 songs never bursts into Spotify's rate limit.
const SPOTIFY_PACING_MS = nonNegativeIntEnv(process.env.CRON_SPOTIFY_PACING_MS, 120);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let spotify = null;
function getSpotify() {
    if (!spotify) {
        spotify = SpotifyApi.withClientCredentials(process.env.SPOTIFY_CLIENT_ID, process.env.SPOTIFY_CLIENT_SECRET);
    }
    return spotify;
}

async function safeSpotify(label, fn, attempt = 1) {
    try {
        return await fn(getSpotify());
    } catch (error) {
        const message = String(error && error.message || '');
        if (attempt === 1 && /429|rate ?limit|Too Many Requests/i.test(message)) {
            console.warn(`[cron] spotify ${label} rate limited; retrying in 5s`);
            await sleep(5000);
            return safeSpotify(label, fn, 2);
        }
        console.warn(`[cron] spotify ${label} failed: ${message}`);
        return null;
    }
}

const defaultDeps = {
    fetchSongsPage: (artistId) => kworb.getArtistSongsPage(artistId),
    fetchAlbumsPage: (artistId) => kworb.getArtistAlbumsPage(artistId),
    getTrack: (id) => safeSpotify(`tracks.get(${id})`, (s) => s.tracks.get(id)),
    getAlbum: (id) => safeSpotify(`albums.get(${id})`, (s) => s.albums.get(id)),
    getArtist: (id) => safeSpotify(`artists.get(${id})`, (s) => s.artists.get(id)),
};

// --- helpers ---------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDateKey(date) {
    return `${pad2(date.getUTCDate())}-${pad2(date.getUTCMonth() + 1)}-${date.getUTCFullYear()}`;
}

// Daily keys are "DD-MM-YYYY". The original cron used "UTC today minus two
// days"; kworb regenerates its pages at ~01:10 UTC and stamps them with the
// previous day ("Last updated: 2026/10/06" all through Oct 7), so the same key
// is "kworb's printed date minus one day". Anchoring on kworb's date keeps the
// key identical no matter when (or how late) the run actually happens, and
// labels the data correctly even if kworb has not regenerated yet.
function dateKeyFor(lastUpdated, now = new Date()) {
    if (typeof lastUpdated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(lastUpdated)) {
        const base = new Date(`${lastUpdated}T00:00:00Z`);
        base.setUTCDate(base.getUTCDate() - 1);
        return formatDateKey(base);
    }
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    base.setUTCDate(base.getUTCDate() - 2);
    return formatDateKey(base);
}

function toInt(text) {
    if (text == null) return null;
    const n = parseInt(String(text).replace(/,/g, ''), 10);
    return Number.isNaN(n) ? null : n;
}

function firstImage(meta) {
    const images = meta && (meta.images || (meta.album && meta.album.images));
    return Array.isArray(images) && images.length > 0 ? images[0].url : null;
}

// --- writers ---------------------------------------------------------------

async function upsertArtist(artistId, overall, dateKey, deps) {
    const row = (type) => (overall || []).find((r) => r.type === type) || {};
    const streams = row('Streams');
    const daily = row('Daily');
    const meta = await deps.getArtist(artistId);

    const set = {
        totalStreams: toInt(streams.total),
        leadStreams: toInt(streams.lead),
        soloStreams: toInt(streams.solo),
        featureStreams: toInt(streams.feature),
        [`dailyTotalStreams.${dateKey}`]: toInt(daily.total) ?? 0,
        [`dailyLeadStreams.${dateKey}`]: toInt(daily.lead) ?? 0,
        [`dailySoloStreams.${dateKey}`]: toInt(daily.solo) ?? 0,
        [`dailyFeatureStreams.${dateKey}`]: toInt(daily.feature) ?? 0,
    };
    const setOnInsert = { spotifyId: artistId };
    if (meta) {
        if (meta.name) set.name = meta.name;
        if (meta.followers && typeof meta.followers.total === 'number') set.followers = meta.followers.total;
        if (typeof meta.popularity === 'number') set.popularity = meta.popularity;
        if (Array.isArray(meta.genres)) set.genres = meta.genres;
        const image = firstImage(meta);
        if (image) set.image = image;
    }
    if (!set.name) setOnInsert.name = artistId; // schema requires a name; Spotify was unreachable

    const result = await Artist.updateOne({ spotifyId: artistId }, { $set: set, $setOnInsert: setOnInsert }, { upsert: true });
    return { created: result.upsertedCount || 0, updated: result.matchedCount || 0, metadata: !!meta };
}

// Shared logic for songs and albums: bulk $set for known ids, create unknown
// ids with Spotify metadata, and backfill metadata on a bounded number of
// existing docs that are missing it.
async function upsertCollection({ Model, artistId, rows, dateKey, fetchMeta, buildMeta, metaFields, label }) {
    const items = (rows || []).filter((r) => r && r.id && kworb.assertArtistId(r.id)).map((r) => ({
        id: r.id, title: r.title, total: toInt(r.total), daily: toInt(r.daily),
    }));
    const stats = { total: items.length, updated: 0, created: 0, backfilled: 0, failed: 0, skipped: (rows || []).length - items.length };
    if (items.length === 0) return stats;

    const existing = new Map(
        (await Model.find({ spotifyId: { $in: items.map((i) => i.id) } }).select(['spotifyId', ...metaFields].join(' ')).lean())
            .map((d) => [d.spotifyId, d])
    );

    const ops = [];
    const toCreate = [];
    const toBackfill = [];
    for (const item of items) {
        const doc = existing.get(item.id);
        if (doc) {
            ops.push({ updateOne: { filter: { spotifyId: item.id }, update: { $set: { totalStreams: item.total, [`dailyStreams.${dateKey}`]: item.daily } } } });
            if (metaFields.some((f) => !doc[f]) && toBackfill.length < METADATA_BACKFILL_PER_ARTIST) toBackfill.push(item);
        } else {
            toCreate.push(item);
        }
    }

    if (ops.length) {
        const result = await Model.bulkWrite(ops, { ordered: false });
        stats.updated = result.modifiedCount + result.upsertedCount;
    }

    for (const item of toCreate) {
        try {
            if (SPOTIFY_PACING_MS) await sleep(SPOTIFY_PACING_MS);
            const meta = await fetchMeta(item.id);
            await Model.create({
                spotifyId: item.id,
                title: item.title,
                artistSpotifyId: artistId,
                totalStreams: item.total,
                dailyStreams: { [dateKey]: item.daily },
                ...buildMeta(meta),
            });
            stats.created++;
        } catch (error) {
            if (error && error.code === 11000) {
                // Created meanwhile (e.g. the same song listed under a featured artist): update instead.
                await Model.updateOne({ spotifyId: item.id }, { $set: { totalStreams: item.total, [`dailyStreams.${dateKey}`]: item.daily } });
                stats.updated++;
            } else {
                stats.failed++;
                console.warn(`[cron] ${label} create failed for ${item.id} (${item.title}): ${error && error.message}`);
            }
        }
    }

    for (const item of toBackfill) {
        if (SPOTIFY_PACING_MS) await sleep(SPOTIFY_PACING_MS);
        const meta = await fetchMeta(item.id);
        const fields = buildMeta(meta);
        const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));
        if (Object.keys(set).length === 0) continue;
        await Model.updateOne({ spotifyId: item.id }, { $set: set });
        stats.backfilled++;
    }

    return stats;
}

function upsertSongs(artistId, songs, dateKey, deps) {
    return upsertCollection({
        Model: Song, artistId, rows: songs, dateKey, label: 'song',
        fetchMeta: deps.getTrack,
        metaFields: ['isrc', 'image'],
        buildMeta: (meta) => ({
            isrc: meta && meta.external_ids && meta.external_ids.isrc ? meta.external_ids.isrc : null,
            image: firstImage(meta),
        }),
    });
}

function upsertAlbums(artistId, albums, dateKey, deps) {
    return upsertCollection({
        Model: Album, artistId, rows: albums, dateKey, label: 'album',
        fetchMeta: deps.getAlbum,
        metaFields: ['image'],
        buildMeta: (meta) => ({ image: firstImage(meta) }),
    });
}

// --- per-artist pipeline -----------------------------------------------------

async function processArtist(artistId, deps = defaultDeps) {
    const songsPage = await deps.fetchSongsPage(artistId);
    if (songsPage.notFound || !songsPage.overall) {
        return { artistId, ok: false, error: 'artist page not found on kworb' };
    }
    const dateKey = dateKeyFor(songsPage.lastUpdated);
    const artist = await upsertArtist(artistId, songsPage.overall, dateKey, deps);
    const songs = await upsertSongs(artistId, songsPage.songs, dateKey, deps);

    const albumsPage = await deps.fetchAlbumsPage(artistId);
    const albums = albumsPage.notFound || !albumsPage.albums
        ? { skipped: true }
        : await upsertAlbums(artistId, albumsPage.albums, dateKey, deps);

    return { artistId, ok: true, dateKey, lastUpdated: songsPage.lastUpdated, artist, songs, albums };
}

async function processArtistWithRetry(artistId, deps = defaultDeps, attempts = ARTIST_ATTEMPTS) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await processArtist(artistId, deps);
        } catch (error) {
            lastError = error;
            console.warn(`[cron] artist ${artistId} attempt ${attempt}/${attempts} failed: ${error && error.message}`);
            if (attempt < attempts) await sleep(Math.min(30000, 2000 * 2 ** (attempt - 1)));
        }
    }
    return { artistId, ok: false, error: lastError && lastError.message };
}

// --- run orchestration -----------------------------------------------------

const state = { running: false, lastRun: null, lastError: null };

async function runDailyUpdate({ artistIds, delayMs = ARTIST_DELAY_MS, deps = defaultDeps } = {}) {
    if (state.running) {
        console.warn('[cron] previous run still in progress; skipping this trigger');
        return { skipped: true, summary: state.lastRun };
    }
    state.running = true;
    const startedAt = new Date();
    const results = [];
    console.log(`[cron] ====== DAILY UPDATE STARTED ${startedAt.toISOString()} ======`);
    try {
        const artists = Array.isArray(artistIds) && artistIds.length
            ? artistIds.map((spotifyId) => ({ spotifyId }))
            : await PriorityArtist.find({}).lean();
        for (const [index, artist] of artists.entries()) {
            const result = await processArtistWithRetry(artist.spotifyId, deps);
            results.push(result);
            console.log(`[cron] ${index + 1}/${artists.length} ${artist.spotifyId}: ${result.ok ? `ok (key ${result.dateKey}, songs ${result.songs.updated}+${result.songs.created}, albums ${result.albums.skipped ? 'skipped' : `${result.albums.updated}+${result.albums.created}`})` : `FAILED: ${result.error}`}`);
            if (index < artists.length - 1 && delayMs > 0) await sleep(delayMs);
        }
    } catch (error) {
        state.lastError = { at: new Date().toISOString(), message: error && error.message };
        console.error('[cron] run aborted:', error);
    } finally {
        state.running = false;
    }
    const finishedAt = new Date();
    const summary = {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt - startedAt,
        artists: results.length,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).map((r) => ({ artistId: r.artistId, error: r.error })),
        dateKeys: [...new Set(results.filter((r) => r.ok).map((r) => r.dateKey))],
    };
    state.lastRun = summary;
    console.log(`[cron] ====== DAILY UPDATE DONE: ${summary.ok}/${summary.artists} artists ok in ${Math.round(summary.durationMs / 1000)}s ======`);
    if (summary.failed.length) console.log('[cron] failed artists:', JSON.stringify(summary.failed));
    return { skipped: false, summary, results };
}

function status() {
    return { schedule: SCHEDULE, timezone: TIMEZONE, running: state.running, lastRun: state.lastRun, lastError: state.lastError };
}

let task = null;
function start() {
    if (task) return task;
    if (!cron.validate(SCHEDULE)) {
        throw new Error(`CRON_SCHEDULE "${SCHEDULE}" is not a valid cron expression`);
    }
    task = cron.schedule(SCHEDULE, () => {
        runDailyUpdate().catch((error) => console.error('[cron] unexpected failure:', error));
    }, { scheduled: true, timezone: TIMEZONE });
    console.log(`[cron] scheduled daily kworb sync at "${SCHEDULE}" (${TIMEZONE})`);
    return task;
}

module.exports = {
    start,
    status,
    runDailyUpdate,
    processArtist,
    processArtistWithRetry,
    dateKeyFor,
    toInt,
    _internals: { upsertArtist, upsertSongs, upsertAlbums, defaultDeps },
};
