'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const kworb = require('../scrapers/kworb');
const { fixture } = require('./helpers');

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const NUMBER = /^-?[\d,.]+$/;

test('artist songs page: overall summary + songs table keep the API row shapes', () => {
    const { overall, songs, lastUpdated } = kworb.parseArtistSongsPage(fixture('kworb-artist-songs.html'));
    assert.match(lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(overall.length, 3);
    assert.deepEqual(overall.map((r) => r.type), ['Streams', 'Daily', 'Tracks']);
    for (const row of overall) {
        assert.deepEqual(Object.keys(row), ['type', 'total', 'lead', 'solo', 'feature']);
        assert.match(row.total, NUMBER);
    }
    assert.equal(songs.length, 30, 'fixture keeps 30 rows');
    for (const song of songs) {
        assert.deepEqual(Object.keys(song), ['id', 'title', 'link', 'total', 'daily']);
        assert.match(song.id, SPOTIFY_ID);
        assert.ok(song.link.startsWith('https://open.spotify.com/track/'));
        assert.equal(song.title, song.title.trim());
        assert.ok(!song.title.startsWith('*'), 'feature marker is stripped');
        assert.match(song.total, NUMBER);
        assert.match(song.daily, NUMBER);
    }
    assert.equal(songs[0].title, 'Cruel Summer');
    assert.ok(songs.some((s) => s.title.startsWith('I Don')), 'the "* I Don’t Wanna Live Forever" feature row is present without its marker');
});

test('artist albums page', () => {
    const { albums } = kworb.parseArtistAlbumsPage(fixture('kworb-artist-albums.html'));
    assert.equal(albums.length, 30);
    for (const album of albums) {
        assert.deepEqual(Object.keys(album), ['id', 'title', 'link', 'total', 'daily']);
        assert.match(album.id, SPOTIFY_ID);
        assert.ok(!album.title.startsWith('^'));
        assert.ok(album.link.startsWith('https://open.spotify.com/album/'));
    }
    assert.equal(albums[0].title, 'Lover');
});

test('a page without tables (kworb 404 body) yields nulls, not a throw', () => {
    assert.deepEqual(kworb.parseArtistSongsPage('<html><body><h1>404</h1></body></html>'), { overall: null, songs: null, lastUpdated: null });
    assert.deepEqual(kworb.parseArtistAlbumsPage('<html><body></body></html>'), { albums: null, lastUpdated: null });
    assert.equal(kworb.parseArtistsPage('<html></html>'), null);
});

test('most streamed artists leaderboard', () => {
    const rows = kworb.parseArtistsPage(fixture('kworb-artists.html'));
    assert.equal(rows.length, 30);
    assert.deepEqual(Object.keys(rows[0]), ['id', 'name', 'total', 'daily', 'lead', 'solo', 'feature']);
    assert.equal(rows[0].name, 'Drake');
    assert.equal(rows[0].id, '3TVXtAsR1Inumwj472S9r4');
    for (const row of rows) { assert.match(row.id, SPOTIFY_ID); assert.match(row.total, NUMBER); }
    assert.equal(kworb.parseArtistsPage(fixture('kworb-artists.html'), 5).length, 5, 'limit is honoured');
});

test('most monthly listeners leaderboard', () => {
    const rows = kworb.parseListenersPage(fixture('kworb-listeners.html'));
    assert.equal(rows.length, 30);
    assert.deepEqual(Object.keys(rows[0]), ['id', 'name', 'total', 'daily', 'peak']);
    for (const row of rows) {
        assert.match(row.id, SPOTIFY_ID);
        assert.ok(!/^\d+$/.test(row.name), 'name column is the artist, not the rank');
        assert.match(row.total, NUMBER);
        assert.match(row.peak, NUMBER);
    }
});

test('"Artist - Title" leaderboards split on the first " - " only', () => {
    const songs = kworb.parseArtistAndTitlePage(fixture('kworb-songs.html'));
    assert.equal(songs.length, 30);
    assert.deepEqual(Object.keys(songs[0]), ['name', 'artist', 'total', 'daily']);
    for (const row of songs) { assert.ok(row.name); assert.ok(row.artist); assert.match(row.total, NUMBER); }
    const albums = kworb.parseArtistAndTitlePage(fixture('kworb-albums.html'));
    assert.deepEqual({ name: albums[0].name, artist: albums[0].artist }, { name: '+-=÷×', artist: 'Ed Sheeran' });
    assert.deepEqual(kworb.splitArtistAndTitle('Tyler, The Creator - See You Again'), { artist: 'Tyler, The Creator', name: 'See You Again' });
    assert.deepEqual(kworb.splitArtistAndTitle('Twenty One Pilots - Heathens - Remix'), { artist: 'Twenty One Pilots', name: 'Heathens - Remix' });
    assert.deepEqual(kworb.splitArtistAndTitle('NoSeparator'), { artist: null, name: 'NoSeparator' });
    assert.deepEqual(kworb.splitArtistAndTitle(null), { artist: null, name: null });
});

test('youtube most viewed videos', () => {
    const rows = kworb.parseYtVideosPage(fixture('kworb-yt-topvideos.html'));
    assert.equal(rows.length, 30);
    assert.deepEqual(Object.keys(rows[0]), ['id', 'name', 'total', 'daily']);
    assert.equal(rows[0].id, 'kJQP7kiw5Fk');
    assert.match(rows[0].name, /Despacito/);
});

test('artist ids are validated before being put in a URL', () => {
    assert.equal(kworb.assertArtistId('06HL4z0CvFAxyc27GXpf02'), true);
    for (const bad of ['', null, undefined, '../../etc/passwd', '06HL4z0CvFAxyc27GXpf0', '06HL4z0CvFAxyc27GXpf02/x', 123]) {
        assert.equal(kworb.assertArtistId(bad), false, `rejects ${String(bad)}`);
    }
});

test('fetchers refuse invalid ids / years without touching the network', async () => {
    assert.deepEqual(await kworb.getArtistSongsPage('nope'), { overall: null, songs: null, lastUpdated: null, notFound: true });
    assert.deepEqual(await kworb.getArtistAlbumsPage('../x'), { albums: null, lastUpdated: null, notFound: true });
    assert.deepEqual(await kworb.getMostStreamedSongs('20xx'), []);
    assert.deepEqual(await kworb.getMostViewedYTVideos('../'), []);
});
