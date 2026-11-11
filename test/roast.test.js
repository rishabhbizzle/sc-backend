'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRoastInput, roastCacheKey, createDailyBudget, RoastInputError } = require('../services/roastService');

test('validateRoastInput normalises whitespace, trims and caps lengths', () => {
    const out = validateRoastInput({ topSongs: [{ name: '  Cruel\n\nSummer ', artist: 'Taylor\tSwift' }], topArtists: ['x'.repeat(500)] });
    assert.deepEqual(out.topSongs, [{ name: 'Cruel Summer', artist: 'Taylor Swift' }]);
    assert.equal(out.topArtists[0].length, 100);
});

test('validateRoastInput rejects malformed payloads, oversized lists and empty input', () => {
    const bad = [
        undefined, null, 'str', [], {},
        { topSongs: 'x', topArtists: [] },
        { topSongs: [], topArtists: {} },
        { topSongs: [], topArtists: [] },
        { topSongs: [{ name: '   ' }, null, 7], topArtists: [42, ''] },
        { topSongs: [], topArtists: Array(11).fill('a') },
        { topSongs: Array(11).fill({ name: 'a', artist: 'b' }), topArtists: [] },
    ];
    for (const b of bad) assert.throws(() => validateRoastInput(b), RoastInputError, JSON.stringify(b));
});

test('validateRoastInput drops unusable entries instead of failing the roast', () => {
    const out = validateRoastInput({
        topSongs: [{ name: 'Local file', artist: '' }, null, { artist: 'no name' }, { name: 'Espresso', artist: 'Sabrina Carpenter', playcount: 9 }],
        topArtists: ['Sabrina Carpenter', undefined, '  '],
        coverImg: 'ignored',
    });
    assert.deepEqual(out, {
        topSongs: [{ name: 'Local file', artist: 'unknown artist' }, { name: 'Espresso', artist: 'Sabrina Carpenter' }],
        topArtists: ['Sabrina Carpenter'],
    });
    assert.deepEqual(validateRoastInput({ topArtists: ['A'] }), { topSongs: [], topArtists: ['A'] }, 'missing lists default to []');
});

test('roastCacheKey is stable for equivalent input and differs otherwise', () => {
    const a = validateRoastInput({ topSongs: [{ name: 'A  B', artist: 'C' }], topArtists: ['D'] });
    const b = validateRoastInput({ topSongs: [{ name: ' A B ', artist: 'C' }], topArtists: ['D '] });
    const c = validateRoastInput({ topSongs: [{ name: 'A B', artist: 'C' }], topArtists: ['E'] });
    assert.equal(roastCacheKey(a), roastCacheKey(b));
    assert.notEqual(roastCacheKey(a), roastCacheKey(c));
    assert.match(roastCacheKey(a), /^roast:[0-9a-f]{64}$/);
});

test('createDailyBudget caps per UTC day and resets the next day', () => {
    let now = new Date('2026-11-08T10:00:00Z');
    const budget = createDailyBudget(2, () => now);
    assert.equal(budget.take(), true);
    assert.equal(budget.take(), true);
    assert.equal(budget.take(), false);
    now = new Date('2026-11-08T23:59:59Z');
    assert.equal(budget.take(), false);
    now = new Date('2026-11-09T00:00:01Z');
    assert.equal(budget.take(), true);
});
