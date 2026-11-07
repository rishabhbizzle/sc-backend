'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRoastInput, roastCacheKey, createDailyBudget, RoastInputError } = require('../services/roastService');

test('validateRoastInput normalises whitespace, trims and caps lengths', () => {
    const out = validateRoastInput({ topSongs: [{ name: '  Cruel\n\nSummer ', artist: 'Taylor\tSwift' }], topArtists: ['x'.repeat(500)] });
    assert.deepEqual(out.topSongs, [{ name: 'Cruel Summer', artist: 'Taylor Swift' }]);
    assert.equal(out.topArtists[0].length, 100);
});

test('validateRoastInput rejects bad shapes', () => {
    const bad = [
        undefined, null, 'str', [], {},
        { topSongs: 'x', topArtists: [] },
        { topSongs: [], topArtists: [] },
        { topSongs: [{ name: 'a' }], topArtists: [] },
        { topSongs: [{ name: 'a', artist: '   ' }], topArtists: [] },
        { topSongs: [], topArtists: [42] },
        { topSongs: [null], topArtists: [] },
        { topSongs: [], topArtists: Array(11).fill('a') },
    ];
    for (const b of bad) assert.throws(() => validateRoastInput(b), RoastInputError, JSON.stringify(b));
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
