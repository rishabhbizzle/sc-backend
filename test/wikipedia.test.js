'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const wiki = require('../scrapers/wikipedia');
const { fixture } = require('./helpers');

const html = fixture('wikipedia-spotify-records.html');
const STREAMS = /^\d[\d,]*$/;
const toInt = (s) => parseInt(s.replace(/,/g, ''), 10);
const nonIncreasing = (rows) => rows.every((r, i) => i === 0 || toInt(rows[i - 1].streams) >= toInt(r.streams));

test('songs in a single day: main list vs holiday list are different tables of the same section', () => {
    const main = wiki.parseSongsSingleDay(html);
    const holiday = wiki.parseSongsSingleDay(html, 'holiday');
    assert.ok(main.length >= 10 && holiday.length >= 10);
    assert.notEqual(main[0].name, holiday[0].name);
    assert.ok(holiday.some((r) => /christmas/i.test(r.name)), 'holiday table is the seasonal one');
    for (const row of [...main, ...holiday]) {
        assert.deepEqual(Object.keys(row), ['name', 'artist', 'streams', 'dateAchieved']);
        assert.match(row.streams, STREAMS);
        assert.ok(row.artist, `artist present for ${row.name}`);
        assert.ok(!/^as of /i.test(row.name), 'the "As of <date>" footer row is dropped');
        assert.ok(!/^["“]/.test(row.name) && !/\[\d+\]/.test(row.name), 'quotes and reference markers are stripped');
    }
    assert.ok(nonIncreasing(main) && nonIncreasing(holiday), 'rows keep the page order (ranked by streams)');
});

test('songs in a single week', () => {
    const rows = wiki.parseSongsSingleWeek(html);
    assert.ok(rows.length >= 10);
    assert.deepEqual(Object.keys(rows[0]), ['name', 'artist', 'streams', 'dateAchieved']);
    assert.ok(rows.every((r) => STREAMS.test(r.streams) && r.dateAchieved));
    assert.ok(nonIncreasing(rows));
    assert.ok(toInt(rows[0].streams) > toInt(wiki.parseSongsSingleDay(html)[0].streams), 'weekly record exceeds the daily record');
});

test('albums in a single day/week: rowspan artist cells carry over and tracks/average are present', () => {
    const day = wiki.parseAlbumsSingle(html, 'day');
    const week = wiki.parseAlbumsSingle(html, 'week');
    assert.ok(day.length >= 10 && week.length >= 10);
    for (const row of [...day, ...week]) {
        assert.deepEqual(Object.keys(row), ['name', 'artist', 'streams', 'dateAchieved', 'tracks', 'average']);
        assert.ok(row.artist, `rowspan artist missing for ${row.name}`);
        assert.match(row.tracks, /^\d+$/);
        assert.match(row.average, STREAMS);
        assert.match(row.streams, STREAMS);
    }
    assert.ok(toInt(week[0].streams) > toInt(day[0].streams));
    assert.ok(nonIncreasing(day) && nonIncreasing(week));
});

test('section walker stops at the next heading of the same level', () => {
    const $ = cheerio.load(html);
    const tables = wiki._internals.sectionTables($, wiki._internals.SECTIONS.songsSingleDay);
    assert.equal(tables.length, 2);
    assert.equal(wiki._internals.sectionTables($, wiki._internals.SECTIONS.songsSingleWeek).length, 1);
});

test('tableToGrid expands rowspan and colspan', () => {
    const $ = cheerio.load('<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td rowspan="2">x</td><td>1</td><td>2</td></tr><tr><td colspan="2">y</td></tr></table>');
    assert.deepEqual(wiki._internals.tableToGrid($, $('table')[0]), [['A', 'B', 'C'], ['x', '1', '2'], ['x', 'y', 'y']]);
});

test('a page whose layout changed raises WikipediaLayoutError instead of returning garbage', () => {
    assert.throws(() => wiki.parseSongsSingleWeek('<html><body><h2 id="Something_else">x</h2><table class="wikitable"><tr><th>Rank</th></tr></table></body></html>'), wiki.WikipediaLayoutError);
    assert.throws(() => wiki.parseSongsSingleDay('<html><body><div class="mw-heading"><h2 id="Most-streamed_songs_in_a_single_day">t</h2></div><table class="wikitable"><tr><th>Song</th><th>Streams</th></tr><tr><td>a</td><td>1</td></tr></table></body></html>', 'holiday'), wiki.WikipediaLayoutError, 'holiday needs a second table');
    assert.throws(() => wiki.parseSongsSingleWeek('<html><body><div class="mw-heading"><h2 id="Most-streamed_songs_in_a_single_week">t</h2></div><table class="wikitable"><tr><th>Foo</th><th>Bar</th></tr></table></body></html>'), /header row/);
});
