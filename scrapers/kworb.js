'use strict';

const cheerio = require('cheerio');
const { fetchHtml, UpstreamNotFoundError } = require('../utilities/http');

// kworb.net is a static site: every table is present in the raw HTML, so we
// parse it with cheerio instead of driving a headless browser. The parse
// functions are pure (HTML in, rows out) and keep the exact row shapes the
// frontend already consumes.

function baseUrl() {
    const src = process.env.DATA_SOURCE || 'https://kworb.net/';
    return src.endsWith('/') ? src : `${src}/`;
}

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const YEAR_RE = /^\d{4}$/;

// textContent-equivalent: empty string becomes null, matching the old
// `cell && cell.textContent ? cell.textContent : null` behaviour.
function cellText($, cells, index) {
    const el = cells[index];
    if (!el) return null;
    const text = $(el).text();
    return text ? text : null;
}

function cellHref($, cells, index) {
    const el = cells[index];
    if (!el) return null;
    const a = $(el).find('a').first();
    return a.length ? (a.attr('href') ?? null) : null;
}

function lastPathSegment(href) {
    if (!href) return null;
    const parts = href.split('/');
    return parts[parts.length - 1] || null;
}

function artistIdFromHref(href) {
    const seg = lastPathSegment(href);
    return seg ? seg.split('_')[0] || null : null;
}

function stripLeading(text, char) {
    if (text == null) return null;
    return text.startsWith(char) ? text.substring(1).trim() : text.trim();
}

// "Artist - Title" split on the FIRST " - " so titles containing dashes survive.
function splitArtistAndTitle(text) {
    if (!text) return { artist: null, name: null };
    const idx = text.indexOf(' - ');
    if (idx === -1) {
        const parts = text.split('-');
        if (parts.length > 1) return { artist: parts[0].trim(), name: parts.slice(1).join('-').trim() };
        return { artist: null, name: text.trim() };
    }
    return { artist: text.slice(0, idx).trim(), name: text.slice(idx + 3).trim() };
}

function rowsOf($, table) {
    return $(table).find('tr').toArray();
}

function tdsOf($, row) {
    return $(row).children('td').toArray();
}

// "Last updated: 2026/10/06" marker on artist pages -> "2026-10-06" (or null).
function parseLastUpdated($) {
    const m = $.root().text().match(/Last updated:\s*(\d{4})\/(\d{2})\/(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// --- artist pages -----------------------------------------------------------

function parseArtistSongsPage(html) {
    const $ = cheerio.load(html);
    const tables = $('table').toArray();
    const lastUpdated = parseLastUpdated($);
    if (tables.length < 2) return { overall: null, songs: null, lastUpdated };

    const overall = rowsOf($, tables[0]).slice(1).map((row) => {
        const tds = tdsOf($, row);
        return {
            type: cellText($, tds, 0),
            total: cellText($, tds, 1),
            lead: cellText($, tds, 2),
            solo: cellText($, tds, 3),
            feature: cellText($, tds, 4),
        };
    });

    const songs = rowsOf($, tables[1]).slice(1).map((row) => {
        const tds = tdsOf($, row);
        const link = cellHref($, tds, 0);
        return {
            id: lastPathSegment(link),
            title: stripLeading(cellText($, tds, 0), '*'),
            link,
            total: cellText($, tds, 1),
            daily: cellText($, tds, 2),
        };
    });

    return { overall, songs, lastUpdated };
}

function parseArtistAlbumsPage(html) {
    const $ = cheerio.load(html);
    const tables = $('table').toArray();
    const lastUpdated = parseLastUpdated($);
    if (tables.length < 1) return { albums: null, lastUpdated };

    const albums = rowsOf($, tables[0]).slice(1).map((row) => {
        const tds = tdsOf($, row);
        const link = cellHref($, tds, 0);
        return {
            id: lastPathSegment(link),
            title: stripLeading(cellText($, tds, 0), '^'),
            link,
            total: cellText($, tds, 1),
            daily: cellText($, tds, 2),
        };
    });
    return { albums, lastUpdated };
}

// --- leaderboards -----------------------------------------------------------

function parseArtistsPage(html, limit = 100) {
    const $ = cheerio.load(html);
    const table = $('table').first();
    if (!table.length) return null;
    return rowsOf($, table).slice(1, limit + 1).map((row) => {
        const tds = tdsOf($, row);
        return {
            id: artistIdFromHref(cellHref($, tds, 0)),
            name: cellText($, tds, 0),
            total: cellText($, tds, 1),
            daily: cellText($, tds, 2),
            lead: cellText($, tds, 3),
            solo: cellText($, tds, 4),
            feature: cellText($, tds, 5),
        };
    });
}

function parseListenersPage(html, limit = 100) {
    const $ = cheerio.load(html);
    const table = $('table').first();
    if (!table.length) return null;
    return rowsOf($, table).slice(1, limit + 1).map((row) => {
        const tds = tdsOf($, row);
        return {
            id: artistIdFromHref(cellHref($, tds, 1) || cellHref($, tds, 0)),
            name: cellText($, tds, 1),
            total: cellText($, tds, 2),
            daily: cellText($, tds, 3),
            peak: cellText($, tds, 5),
        };
    });
}

// songs.html / songs_<year>.html / albums.html: "Artist - Title", Streams, Daily
function parseArtistAndTitlePage(html, limit = 100) {
    const $ = cheerio.load(html);
    const table = $('table').first();
    if (!table.length) return null;
    return rowsOf($, table).slice(1, limit + 1).map((row) => {
        const tds = tdsOf($, row);
        const { artist, name } = splitArtistAndTitle(cellText($, tds, 0));
        return {
            name,
            artist,
            total: cellText($, tds, 1),
            daily: cellText($, tds, 2),
        };
    });
}

function parseYtVideosPage(html, limit = 200) {
    const $ = cheerio.load(html);
    const table = $('table').first();
    if (!table.length) return null;
    return rowsOf($, table).slice(1, limit + 1).map((row) => {
        const tds = tdsOf($, row);
        const href = cellHref($, tds, 0);
        const seg = lastPathSegment(href);
        return {
            id: seg ? seg.replace(/\.html$/, '') : null,
            name: cellText($, tds, 0),
            total: cellText($, tds, 1),
            daily: cellText($, tds, 2),
        };
    });
}

// --- fetchers ---------------------------------------------------------------

async function fetchOrNotFound(url) {
    try {
        return { html: await fetchHtml(url), notFound: false };
    } catch (err) {
        if (err instanceof UpstreamNotFoundError) return { html: null, notFound: true };
        throw err;
    }
}

// Artist ids come straight from the URL, so refuse anything that is not a
// Spotify id before it is interpolated into an upstream path.
function assertArtistId(artistId) {
    return typeof artistId === 'string' && SPOTIFY_ID_RE.test(artistId);
}

async function getArtistSongsPage(artistId) {
    if (!assertArtistId(artistId)) return { overall: null, songs: null, lastUpdated: null, notFound: true };
    const { html, notFound } = await fetchOrNotFound(`${baseUrl()}spotify/artist/${artistId}_songs.html`);
    if (notFound) return { overall: null, songs: null, lastUpdated: null, notFound: true };
    return { ...parseArtistSongsPage(html), notFound: false };
}

async function getArtistAlbumsPage(artistId) {
    if (!assertArtistId(artistId)) return { albums: null, lastUpdated: null, notFound: true };
    const { html, notFound } = await fetchOrNotFound(`${baseUrl()}spotify/artist/${artistId}_albums.html`);
    if (notFound) return { albums: null, lastUpdated: null, notFound: true };
    return { ...parseArtistAlbumsPage(html), notFound: false };
}

async function getMostStreamedArtists(limit = 100) {
    const html = await fetchHtml(`${baseUrl()}spotify/artists.html`);
    return parseArtistsPage(html, limit);
}

async function getMostMonthlyListeners(limit = 100) {
    const html = await fetchHtml(`${baseUrl()}spotify/listeners.html`);
    return parseListenersPage(html, limit);
}

async function getMostStreamedSongs(year, limit = 100) {
    if (year != null && year !== '' && !YEAR_RE.test(String(year))) return [];
    const url = year ? `${baseUrl()}spotify/songs_${year}.html` : `${baseUrl()}spotify/songs.html`;
    const { html, notFound } = await fetchOrNotFound(url);
    if (notFound) return [];
    return parseArtistAndTitlePage(html, limit);
}

async function getMostStreamedAlbums(limit = 100) {
    const html = await fetchHtml(`${baseUrl()}spotify/albums.html`);
    return parseArtistAndTitlePage(html, limit);
}

async function getMostViewedYTVideos(year, limit = 200) {
    if (year != null && year !== '' && !YEAR_RE.test(String(year))) return [];
    const url = year ? `${baseUrl()}youtube/topvideos${year}.html` : `${baseUrl()}youtube/topvideos.html`;
    const { html, notFound } = await fetchOrNotFound(url);
    if (notFound) return [];
    return parseYtVideosPage(html, limit);
}

module.exports = {
    // parsers (pure)
    parseArtistSongsPage,
    parseArtistAlbumsPage,
    parseArtistsPage,
    parseListenersPage,
    parseArtistAndTitlePage,
    parseYtVideosPage,
    splitArtistAndTitle,
    // fetchers
    getArtistSongsPage,
    getArtistAlbumsPage,
    getMostStreamedArtists,
    getMostMonthlyListeners,
    getMostStreamedSongs,
    getMostStreamedAlbums,
    getMostViewedYTVideos,
    assertArtistId,
};
