'use strict';

const cheerio = require('cheerio');
const { fetchHtml } = require('../utilities/http');

// "List of Spotify streaming records" on Wikipedia. The old implementation
// picked tables by numeric index (tables[7], tables[13] ...). Editors add and
// remove tables regularly, which silently pointed the API at the wrong table
// (today index 7 is the holiday list, 8 is a colour legend and 13/14 are
// unrelated). Tables are now located by their section heading and columns by
// their header text, and rowspan/colspan cells are expanded so merged artist
// cells carry over to the rows below them.

// Overridable so the integration tests can point it at a local mock.
const PAGE_URL = process.env.WIKIPEDIA_RECORDS_URL || 'https://en.wikipedia.org/wiki/List_of_Spotify_streaming_records';
// Wikimedia asks automated clients to identify themselves with contact info.
const USER_AGENT = 'StatsCraveBot/1.0 (+https://statscrave.com; reads the public streaming-records tables)';

class WikipediaLayoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WikipediaLayoutError';
        this.code = 'WIKI_LAYOUT_CHANGED';
    }
}

const SECTIONS = {
    songsSingleDay: { id: 'Most-streamed_songs_in_a_single_day', text: /most-?streamed songs in a single day/i },
    songsSingleWeek: { id: 'Most-streamed_songs_in_a_single_week', text: /most-?streamed songs in a single week/i },
    albumsSingleDay: { id: 'Most_streamed_albums_in_a_single_day', text: /most-?streamed albums in a single day/i },
    albumsSingleWeek: { id: 'Most_streamed_albums_in_a_single_week', text: /most-?streamed albums in a single week/i },
};

function headingLevel(el) {
    const m = /^h([1-6])$/i.exec(el.tagName || el.name || '');
    return m ? parseInt(m[1], 10) : null;
}

// Returns the heading element for a section, by id first and by text second.
function findHeading($, section) {
    let h = $(`#${section.id}`).first();
    if (h.length && headingLevel(h[0])) return h;
    const byText = $('h2, h3, h4').toArray().find((el) => section.text.test($(el).text()));
    return byText ? $(byText) : null;
}

// All wikitables that belong to a section: walk the siblings after the heading
// (modern Wikipedia wraps headings in <div class="mw-heading">) until the next
// heading of the same or higher level.
function sectionTables($, section) {
    const heading = findHeading($, section);
    if (!heading) return null;
    const level = headingLevel(heading[0]);
    const start = heading.parent().is('.mw-heading') ? heading.parent() : heading;
    const tables = [];
    let node = start.next();
    while (node.length) {
        const el = node[0];
        const nestedHeading = node.is('.mw-heading') ? node.children('h1,h2,h3,h4,h5,h6').first() : (headingLevel(el) ? node : null);
        if (nestedHeading && nestedHeading.length && headingLevel(nestedHeading[0]) <= level) break;
        if (node.is('table.wikitable')) tables.push(el);
        else node.find('table.wikitable').each((_, t) => tables.push(t));
        node = node.next();
    }
    return tables;
}

// Expand a <table> into a grid of cell texts, honouring rowspan/colspan so
// every row has a value in every column. <th> cells are included so the data
// columns line up with the header row.
function tableToGrid($, table) {
    const grid = [];
    const rows = $(table).find('tr').toArray();
    rows.forEach((row, r) => {
        grid[r] = grid[r] || [];
        let c = 0;
        $(row).children('th, td').each((_, cell) => {
            while (grid[r][c] !== undefined) c++;
            const text = cleanCell($, cell);
            const rowspan = Math.max(1, parseInt($(cell).attr('rowspan'), 10) || 1);
            const colspan = Math.max(1, parseInt($(cell).attr('colspan'), 10) || 1);
            for (let dr = 0; dr < rowspan; dr++) {
                grid[r + dr] = grid[r + dr] || [];
                for (let dc = 0; dc < colspan; dc++) grid[r + dr][c + dc] = text;
            }
            c += colspan;
        });
    });
    return grid;
}

function cleanCell($, cell) {
    const clone = $(cell).clone();
    clone.find('sup, .reference, style, script').remove();
    return clone.text()
        .replace(/\[[^\]]*\]/g, '')      // [12], [W], [note 1]
        .replace(/\s+/g, ' ')
        .trim();
}

// "Cruel Summer" / “Cruel Summer” -> Cruel Summer
function unquote(text) {
    if (text == null) return null;
    return text.replace(/^["“”']+|["“”']+$/g, '').trim() || null;
}

function headerIndex(headers, pattern) {
    const i = headers.findIndex((h) => pattern.test(h));
    return i === -1 ? null : i;
}

function parseRecordsTable($, table, kind) {
    const grid = tableToGrid($, table);
    const headerRowIdx = grid.findIndex((row) => row.some((h) => /^(song|album)/i.test(h || '')) && row.some((h) => /^streams/i.test(h || '')));
    if (headerRowIdx === -1) throw new WikipediaLayoutError(`${kind}: could not find a header row with Song/Album and Streams columns`);
    const headers = grid[headerRowIdx].map((h) => (h || '').toLowerCase());
    const col = {
        name: headerIndex(headers, /^(song|album)/),
        artist: headerIndex(headers, /^artist/),
        streams: headerIndex(headers, /^streams/),
        dateAchieved: headerIndex(headers, /^date achieved/),
        tracks: headerIndex(headers, /^tracks/),
        average: headerIndex(headers, /^average/),
    };
    const pick = (row, i) => (i == null ? null : (row[i] ?? null) || null);
    return grid.slice(headerRowIdx + 1)
        // Skip header repeats and the "As of <date>" footer, whose single colspan cell
        // the grid expansion copies into every column.
        .filter((row) => {
            const name = pick(row, col.name);
            const streams = pick(row, col.streams);
            return name && streams && /^\d[\d,.]*$/.test(streams) && name !== streams;
        })
        .map((row) => ({
            name: unquote(pick(row, col.name)),
            artist: pick(row, col.artist),
            streams: pick(row, col.streams),
            dateAchieved: pick(row, col.dateAchieved),
            ...(kind.startsWith('albums') ? { tracks: pick(row, col.tracks), average: pick(row, col.average) } : {}),
        }));
}

function requireSection($, key, minTables = 1) {
    const tables = sectionTables($, SECTIONS[key]);
    if (!tables) throw new WikipediaLayoutError(`section "${SECTIONS[key].id}" not found on the Wikipedia page`);
    if (tables.length < minTables) throw new WikipediaLayoutError(`section "${SECTIONS[key].id}" has ${tables.length} table(s), expected at least ${minTables}`);
    return tables;
}

// --- parsers (pure) -----------------------------------------------------

// type === 'holiday' -> the second table of the section (seasonal songs),
// anything else -> the first table (the main all-time list).
function parseSongsSingleDay(html, type) {
    const $ = cheerio.load(html);
    const holiday = type === 'holiday';
    const tables = requireSection($, 'songsSingleDay', holiday ? 2 : 1);
    return parseRecordsTable($, tables[holiday ? 1 : 0], 'songsSingleDay');
}

function parseSongsSingleWeek(html) {
    const $ = cheerio.load(html);
    const tables = requireSection($, 'songsSingleWeek');
    return parseRecordsTable($, tables[0], 'songsSingleWeek');
}

function parseAlbumsSingle(html, mode = 'day') {
    const $ = cheerio.load(html);
    const key = mode === 'week' ? 'albumsSingleWeek' : 'albumsSingleDay';
    const tables = requireSection($, key);
    return parseRecordsTable($, tables[0], key);
}

// --- fetchers ------------------------------------------------------------

function fetchPage() {
    return fetchHtml(PAGE_URL, { userAgent: USER_AGENT });
}

async function getMostStreamedSongsInSingleDay(type) {
    return parseSongsSingleDay(await fetchPage(), type);
}

async function getMostStreamedSongsInSingleWeek() {
    return parseSongsSingleWeek(await fetchPage());
}

async function getMostStreamedAlbumInSingle(mode = 'day') {
    return parseAlbumsSingle(await fetchPage(), mode);
}

module.exports = {
    PAGE_URL,
    WikipediaLayoutError,
    parseSongsSingleDay,
    parseSongsSingleWeek,
    parseAlbumsSingle,
    getMostStreamedSongsInSingleDay,
    getMostStreamedSongsInSingleWeek,
    getMostStreamedAlbumInSingle,
    _internals: { sectionTables, tableToGrid, SECTIONS },
};
