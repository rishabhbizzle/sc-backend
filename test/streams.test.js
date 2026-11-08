'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../utilities/streams');

const d = (key) => s.parseKey(key);

test('parseKey: DD-MM-YYYY to UTC midnight; rejects malformed and rolled-over dates', () => {
    assert.equal(d('05-10-2026').toISOString(), '2026-10-05T00:00:00.000Z');
    assert.equal(d('31-02-2026'), null);
    assert.equal(d('2026-10-05'), null);
    assert.equal(d('5-10-2026'), null);
    assert.equal(d(undefined), null);
    assert.equal(s.formatKey(d('01-01-2026')), '01-01-2026');
});

test('series: sorts across month and year boundaries, drops nulls/non-numbers/bad keys', () => {
    const out = s.series({ '01-01-2026': 3, '31-12-2025': 2, '30-11-2025': 1, '02-01-2026': null, 'garbage': 9, '03-01-2026': 'x', '04-01-2026': NaN });
    assert.deepEqual(out.map((p) => p.key), ['30-11-2025', '31-12-2025', '01-01-2026']);
    assert.deepEqual(out.map((p) => p.value), [1, 2, 3]);
    assert.deepEqual(s.series(null), []);
    assert.deepEqual(s.series('nope'), []);
});

test('latest / previous / pctChange', () => {
    const ser = s.series({ '01-01-2026': 100, '02-01-2026': 110 });
    assert.equal(s.latest(ser).value, 110);
    assert.equal(s.previous(ser).value, 100);
    assert.equal(s.latest([]), null);
    assert.equal(s.previous(ser.slice(0, 1)), null);
    assert.equal(s.pctChange(110, 100), 10);
    assert.equal(s.pctChange(90, 100), -10);
    assert.equal(s.pctChange(1031, 1000), 3.1);
    assert.equal(s.pctChange(5, 0), null);
    assert.equal(s.pctChange(null, 5), null);
});

test('avgDaily: last 7 points inside a 10-day window, at least 3 points', () => {
    const obj = {};
    for (let i = 1; i <= 10; i++) obj[`${String(i).padStart(2, '0')}-01-2026`] = i * 10;
    const ser = s.series(obj);
    // last 7 of days 1..10 = 40..100 -> avg 70
    assert.equal(s.avgDaily(ser, d('10-01-2026')), 70);
    // gaps: only 2 points in the window -> null
    const sparse = s.series({ '01-01-2026': 5, '09-01-2026': 5, '10-01-2026': 5 });
    assert.equal(s.avgDaily(sparse, d('10-01-2026')), 5, '3 points inside the window is enough');
    assert.equal(s.avgDaily(s.series({ '09-01-2026': 5, '10-01-2026': 5 }), d('10-01-2026')), null);
    // stale: nothing in the window
    assert.equal(s.avgDaily(ser, d('30-01-2026')), null);
    assert.equal(s.avgDaily([], d('10-01-2026')), null);
    assert.equal(s.avgDaily(ser, null), null);
});

test('nextMilestone: 100M steps for songs/albums, 1B for artists; major on whole billions', () => {
    assert.deepEqual(s.nextMilestone('song', 2_950_000_000), { value: 3_000_000_000, major: true });
    assert.deepEqual(s.nextMilestone('song', 3_000_000_000), { value: 3_100_000_000, major: false }, 'exactly on a milestone -> the next one');
    assert.deepEqual(s.nextMilestone('album', 12), { value: 100_000_000, major: false });
    assert.deepEqual(s.nextMilestone('artist', 101_400_000_000), { value: 102_000_000_000, major: true });
    assert.equal(s.nextMilestone('song', null), null);
    assert.equal(s.nextMilestone('song', -1), null);
});

test('etaDays: ceil, at least 1, null without a positive average', () => {
    assert.equal(s.etaDays(2_950_000_000, 4_200_000, 3_000_000_000), 12);
    assert.equal(s.etaDays(2_999_999_999, 4_200_000, 3_000_000_000), 1);
    assert.equal(s.etaDays(3_000_000_000, 4_200_000, 3_000_000_000), 0);
    assert.equal(s.etaDays(1, 0, 100), null);
    assert.equal(s.etaDays(1, null, 100), null);
    assert.equal(s.etaDays(1, -5, 100), null);
});

test('crossed: every milestone passed, exclusive of the start, inclusive of the end', () => {
    assert.deepEqual(s.crossed('song', 2_950_000_000, 3_050_000_000), [3_000_000_000]);
    assert.deepEqual(s.crossed('song', 2_950_000_000, 3_000_000_000), [3_000_000_000]);
    assert.deepEqual(s.crossed('song', 3_000_000_000, 3_050_000_000), [], 'already at 3B yesterday');
    assert.deepEqual(s.crossed('song', 150_000_000, 420_000_000), [200_000_000, 300_000_000, 400_000_000]);
    assert.deepEqual(s.crossed('artist', 99_900_000_000, 100_100_000_000), [100_000_000_000]);
    assert.deepEqual(s.crossed('song', 500, 400), []);
    assert.deepEqual(s.crossed('song', null, 400), []);
});

test('totalAt: reconstructs past totals; null when history is too short or gappy', () => {
    const ser = s.series({ '01-01-2026': 10, '02-01-2026': 20, '03-01-2026': 30 });
    assert.equal(s.totalAt(1000, ser, d('03-01-2026')), 1000);
    assert.equal(s.totalAt(1000, ser, d('02-01-2026')), 970);
    assert.equal(s.totalAt(1000, ser, d('31-12-2025')), 940, 'the day before history starts is still exact');
    assert.equal(s.totalAt(1000, ser, d('30-12-2025')), null);
    const gappy = s.series({ '01-01-2026': 10, '03-01-2026': 30 });
    assert.equal(s.totalAt(1000, gappy, d('01-01-2026')), null, 'a missing day after the date makes it a guess');
    assert.equal(s.totalAt(1000, gappy, d('03-01-2026')), 1000);
    assert.equal(s.totalAt(null, ser, d('02-01-2026')), null);
});

test('isRecord: latest strictly above every earlier day, only with enough history', () => {
    const make = (values) => s.series(Object.fromEntries(values.map((v, i) => [s.formatKey(s.addDays(d('01-01-2026'), i)), v])));
    const rising = Array.from({ length: 30 }, (_, i) => i + 1);
    assert.equal(s.isRecord(make(rising)), true);
    assert.equal(s.isRecord(make(rising.slice(0, 29))), false, '29 days is not enough history');
    assert.equal(s.isRecord(make([...rising.slice(0, 29), 29])), false, 'a tie is not a record');
    assert.equal(s.isRecord(make(Array(30).fill(0))), false);
});
