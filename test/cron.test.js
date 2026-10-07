'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const kworb = require('../scrapers/kworb');
const cron = require('../cron/controller');
const Song = require('../models/songModel');
const Album = require('../models/albumModel');
const Artist = require('../models/artistModel');
const PriorityArtist = require('../models/priorityArtists');
const { fixture, sleep } = require('./helpers');

const TS = '06HL4z0CvFAxyc27GXpf02';
const songsHtml = fixture('kworb-artist-songs.html');
const albumsHtml = fixture('kworb-artist-albums.html');
const parsedSongs = kworb.parseArtistSongsPage(songsHtml);
const parsedAlbums = kworb.parseArtistAlbumsPage(albumsHtml);

function makeDeps({ lastUpdated = '2026-10-06', failSongsFetches = 0, notFound = false, slowMs = 0 } = {}) {
    let songsCalls = 0;
    const calls = { getTrack: 0, getAlbum: 0, getArtist: 0 };
    return {
        calls,
        fetchSongsPage: async () => {
            if (slowMs) await sleep(slowMs);
            if (songsCalls++ < failSongsFetches) throw new Error('kworb hiccup');
            if (notFound) return { overall: null, songs: null, lastUpdated: null, notFound: true };
            return { ...kworb.parseArtistSongsPage(songsHtml), lastUpdated, notFound: false };
        },
        fetchAlbumsPage: async () => ({ ...kworb.parseArtistAlbumsPage(albumsHtml), notFound: false }),
        getTrack: async (id) => { calls.getTrack++; return { external_ids: { isrc: `ISRC-${id}` }, album: { images: [{ url: `img-${id}` }] } }; },
        getAlbum: async (id) => { calls.getAlbum++; return { images: [{ url: `aimg-${id}` }] }; },
        getArtist: async () => { calls.getArtist++; return { name: 'Taylor Swift', followers: { total: 123 }, popularity: 98, genres: ['pop'], images: [{ url: 'artist-img' }] }; },
    };
}

let mongod;
test.before(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'crontest' });
});
test.after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});
test.beforeEach(async () => {
    await Promise.all([Song.deleteMany({}), Album.deleteMany({}), Artist.deleteMany({}), PriorityArtist.deleteMany({})]);
});

test('dateKeyFor: kworb date minus one day, wall clock minus two as fallback', () => {
    assert.equal(cron.dateKeyFor('2026-10-06'), '05-10-2026');
    assert.equal(cron.dateKeyFor('2026-01-01'), '31-12-2025');
    assert.equal(cron.dateKeyFor(null, new Date('2026-10-07T20:52:00Z')), '05-10-2026');
    assert.equal(cron.dateKeyFor('garbage', new Date('2026-03-01T00:00:00Z')), '27-02-2026');
});

test('toInt strips thousands separators and never yields NaN', () => {
    assert.equal(cron.toInt('3,504,258,191'), 3504258191);
    assert.equal(cron.toInt(null), null);
    assert.equal(cron.toInt('n/a'), null);
});

test('first run creates the artist, its songs and albums under the kworb-derived key', async () => {
    const deps = makeDeps();
    const r = await cron.processArtist(TS, deps);
    assert.equal(r.ok, true);
    assert.equal(r.dateKey, '05-10-2026');
    assert.deepEqual({ created: r.artist.created, metadata: r.artist.metadata }, { created: 1, metadata: true });
    assert.deepEqual({ total: r.songs.total, created: r.songs.created, updated: r.songs.updated, failed: r.songs.failed }, { total: 30, created: 30, updated: 0, failed: 0 });
    assert.deepEqual({ created: r.albums.created, updated: r.albums.updated }, { created: 30, updated: 0 });

    const artist = await Artist.findOne({ spotifyId: TS }).lean();
    assert.equal(artist.name, 'Taylor Swift');
    assert.equal(artist.followers, 123);
    assert.equal(artist.image, 'artist-img');
    assert.equal(artist.totalStreams, cron.toInt(parsedSongs.overall[0].total));
    assert.equal(artist.dailyTotalStreams['05-10-2026'], cron.toInt(parsedSongs.overall[1].total));
    assert.equal(artist.dailyFeatureStreams['05-10-2026'], cron.toInt(parsedSongs.overall[1].feature));

    const first = parsedSongs.songs[0];
    const song = await Song.findOne({ spotifyId: first.id }).lean();
    assert.equal(song.title, first.title);
    assert.equal(song.artistSpotifyId, TS);
    assert.equal(song.isrc, `ISRC-${first.id}`);
    assert.equal(song.image, `img-${first.id}`);
    assert.equal(song.totalStreams, cron.toInt(first.total));
    assert.deepEqual(song.dailyStreams, { '05-10-2026': cron.toInt(first.daily) });

    const album = await Album.findOne({ spotifyId: parsedAlbums.albums[0].id }).lean();
    assert.equal(album.title, parsedAlbums.albums[0].title);
    assert.equal(album.image, `aimg-${parsedAlbums.albums[0].id}`);
    assert.equal(await Song.countDocuments(), 30);
    assert.equal(await Album.countDocuments(), 30);
});

test('later runs add a new daily key without touching earlier keys or re-fetching metadata', async () => {
    await cron.processArtist(TS, makeDeps({ lastUpdated: '2026-10-06' }));
    const deps = makeDeps({ lastUpdated: '2026-10-07' });
    const r = await cron.processArtist(TS, deps);
    assert.equal(r.dateKey, '06-10-2026');
    assert.deepEqual({ created: r.songs.created, updated: r.songs.updated, backfilled: r.songs.backfilled }, { created: 0, updated: 30, backfilled: 0 });
    assert.equal(deps.calls.getTrack, 0, 'no Spotify lookups for songs that already have metadata');
    const song = await Song.findOne({ spotifyId: parsedSongs.songs[0].id }).lean();
    assert.deepEqual(Object.keys(song.dailyStreams).sort(), ['05-10-2026', '06-10-2026']);
    const artist = await Artist.findOne({ spotifyId: TS }).lean();
    assert.deepEqual(Object.keys(artist.dailyTotalStreams).sort(), ['05-10-2026', '06-10-2026']);
    assert.equal(await Artist.countDocuments(), 1);

    // Same day again is idempotent: no new docs, no new keys (updatedAt is bumped by
    // the schema timestamps, which is how operators see the cron is alive).
    const again = await cron.processArtist(TS, makeDeps({ lastUpdated: '2026-10-07' }));
    assert.deepEqual({ created: again.songs.created, updated: again.songs.updated }, { created: 0, updated: 30 });
    assert.equal(await Song.countDocuments(), 30);
    const same = await Song.findOne({ spotifyId: parsedSongs.songs[0].id }).lean();
    assert.deepEqual(Object.keys(same.dailyStreams).sort(), ['05-10-2026', '06-10-2026']);
});

test('existing songs missing metadata are backfilled (bounded per run)', async () => {
    const first = parsedSongs.songs[0];
    await Song.create({ spotifyId: first.id, title: 'placeholder', dailyStreams: { '01-01-2026': 1 } });
    const deps = makeDeps();
    const r = await cron.processArtist(TS, deps);
    assert.equal(r.songs.backfilled, 1);
    assert.equal(r.songs.created, 29);
    const song = await Song.findOne({ spotifyId: first.id }).lean();
    assert.equal(song.isrc, `ISRC-${first.id}`);
    assert.equal(song.image, `img-${first.id}`);
    assert.deepEqual(Object.keys(song.dailyStreams).sort(), ['01-01-2026', '05-10-2026']);
});

test('a song whose Spotify lookup fails is still stored (without metadata) and does not abort the artist', async () => {
    const deps = makeDeps();
    deps.getTrack = async () => null;
    const r = await cron.processArtist(TS, deps);
    assert.equal(r.songs.created, 30);
    assert.equal(r.songs.failed, 0);
    const song = await Song.findOne({ spotifyId: parsedSongs.songs[0].id }).lean();
    assert.equal(song.isrc, null);
});

test('an artist kworb does not track is reported, not thrown, and writes nothing', async () => {
    const r = await cron.processArtist(TS, makeDeps({ notFound: true }));
    assert.deepEqual(r, { artistId: TS, ok: false, error: 'artist page not found on kworb' });
    assert.equal(await Artist.countDocuments(), 0);
});

test('processArtistWithRetry survives a transient fetch failure', async () => {
    const r = await cron.processArtistWithRetry(TS, makeDeps({ failSongsFetches: 1 }), 2);
    assert.equal(r.ok, true);
    const gaveUp = await cron.processArtistWithRetry(TS, makeDeps({ failSongsFetches: 5 }), 2);
    assert.deepEqual(gaveUp, { artistId: TS, ok: false, error: 'kworb hiccup' });
});

test('runDailyUpdate walks the priority list, reports a summary, and skips overlapping runs', async () => {
    await PriorityArtist.create({ spotifyId: TS, cmId: '2762' });
    const slow = makeDeps({ slowMs: 150 });
    const [first, second] = await Promise.all([
        cron.runDailyUpdate({ delayMs: 0, deps: slow }),
        (async () => { await sleep(20); return cron.runDailyUpdate({ delayMs: 0, deps: makeDeps() }); })(),
    ]);
    assert.equal(second.skipped, true, 'the overlapping trigger is skipped');
    assert.equal(first.skipped, false);
    assert.deepEqual({ artists: first.summary.artists, ok: first.summary.ok, failed: first.summary.failed, dateKeys: first.summary.dateKeys }, { artists: 1, ok: 1, failed: [], dateKeys: ['05-10-2026'] });
    assert.equal(cron.status().running, false);
    assert.equal(cron.status().lastRun.ok, 1);
    assert.equal(await Song.countDocuments(), 30);
});
