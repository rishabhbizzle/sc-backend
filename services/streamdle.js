'use strict';

// Streamdle: a daily "which song has more Spotify streams?" game. One puzzle
// per UTC day, generated deterministically from the date, with ten rounds that
// get closer (harder) as you go. Totals are frozen in the puzzle and only
// revealed one round at a time by POST /game/answer, so the page never carries
// the answers.

const DailyGame = require('../models/dailyGameModel');
const GameResult = require('../models/gameResultModel');
const Insight = require('../models/insightModel');
const { BadRequestError } = require('../utilities/errors');
const { DAY_MS } = require('../utilities/streams');

const ROUNDS = 10;
const MIN_TOTAL = 100_000_000;
const RECENT_GAMES = 30;
// allowed ratio (bigger / smaller) per round: obvious at first, close at the end
const BANDS = [[2, 3.5], [2, 3], [1.6, 2.4], [1.5, 2], [1.35, 1.8], [1.25, 1.6], [1.18, 1.4], [1.12, 1.3], [1.08, 1.2], [1.05, 1.12]];

class GameNotReadyError extends Error {
    constructor(message = "Today's Streamdle isn't ready yet") {
        super(message);
        this.name = 'GameNotReadyError';
    }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const utcDate = (now = new Date()) => now.toISOString().slice(0, 10);
const shiftDate = (date, days) => utcDate(new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS));

// Small seeded PRNG (mulberry32) so a date always yields the same puzzle.
function seeded(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    let a = h >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// "Style (Taylor's Version) [From The Vault]" and "Style" are the same song for
// the game's purposes: never pair them, never use both in one day.
const baseName = (name) => String(name || '')
    .toLowerCase()
    .replace(/[([].*?[)\]]/g, ' ')
    .replace(/\s-\s.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function generateRounds(gameDate, pool, recentIds = new Set()) {
    const rand = seeded(`streamdle:${gameDate}`);
    let candidates = pool.filter((p) => p.total >= MIN_TOTAL && p.image && p.name);
    const fresh = candidates.filter((p) => !recentIds.has(p.spotifyId));
    if (fresh.length >= 40) candidates = fresh;
    // stable order before random picks, so the same inputs give the same game
    candidates = [...candidates].sort((x, y) => (x.spotifyId < y.spotifyId ? -1 : 1));
    if (candidates.length < 4) throw new GameNotReadyError();

    const used = new Set();
    const key = (p) => `${baseName(p.name)}|${p.artistName || ''}`;
    const rounds = [];
    for (let r = 0; r < ROUNDS; r++) {
        const [lo, hi] = BANDS[r];
        let picked = null;
        for (let attempt = 0; attempt < 300 && !picked; attempt++) {
            // after many misses, accept any pair that isn't a near-tie
            const [min, max] = attempt < 200 ? [lo, hi] : [1.05, Infinity];
            const a = candidates[Math.floor(rand() * candidates.length)];
            if (used.has(key(a))) continue;
            const options = candidates.filter((b) => {
                if (b === a || used.has(key(b)) || baseName(b.name) === baseName(a.name)) return false;
                const ratio = Math.max(a.total, b.total) / Math.min(a.total, b.total);
                return ratio >= min && ratio <= max;
            });
            if (!options.length) continue;
            const b = options[Math.floor(rand() * options.length)];
            picked = rand() < 0.5 ? { a, b } : { a: b, b: a };
        }
        if (!picked) throw new GameNotReadyError();
        used.add(key(picked.a));
        used.add(key(picked.b));
        const side = (p) => ({ spotifyId: p.spotifyId, name: p.name, artistName: p.artistName || null, image: p.image, total: p.total });
        rounds.push({ a: side(picked.a), b: side(picked.b) });
    }
    return rounds;
}

async function ensureGame(gameDate) {
    const existing = await DailyGame.findOne({ gameDate }).lean();
    if (existing) return existing;
    const [pool, recent] = await Promise.all([
        Insight.find({ type: 'song', total: { $gte: MIN_TOTAL }, image: { $ne: null } }).select('spotifyId name artistName image total -_id').lean(),
        DailyGame.find({ gameDate: { $lt: gameDate } }).sort({ gameDate: -1 }).limit(RECENT_GAMES).select('rounds').lean(),
    ]);
    const recentIds = new Set(recent.flatMap((g) => g.rounds.flatMap((r) => [r.a.spotifyId, r.b.spotifyId])));
    const rounds = generateRounds(gameDate, pool, recentIds);
    // Numbered in order of play (#1 is the first puzzle ever made), so the
    // count starts at 1 whenever this ships.
    const number = (await DailyGame.countDocuments({ gameDate: { $lt: gameDate } })) + 1;
    try {
        return (await DailyGame.create({ gameDate, number, rounds })).toObject();
    } catch (error) {
        if (error && error.code === 11000) return DailyGame.findOne({ gameDate }).lean(); // made concurrently
        throw error;
    }
}

const hide = ({ total, ...rest }) => rest;
const publicGame = (game) => ({ gameDate: game.gameDate, number: game.number, rounds: game.rounds.map((r) => ({ a: hide(r.a), b: hide(r.b) })) });
const winnerOf = (round) => (round.a.total > round.b.total ? 'a' : 'b');

// Only today's puzzle, or yesterday's for someone finishing across midnight.
function parseGameDate(value, now) {
    const today = utcDate(now);
    if (typeof value !== 'string' || !DATE_RE.test(value) || ![today, shiftDate(today, -1)].includes(value)) {
        throw new BadRequestError("gameDate must be today's or yesterday's puzzle");
    }
    return value;
}

function parseAnswer(body, now = new Date()) {
    const b = body && typeof body === 'object' ? body : {};
    const round = b.round;
    if (!Number.isInteger(round) || round < 0 || round >= ROUNDS) throw new BadRequestError(`round must be 0-${ROUNDS - 1}`);
    if (b.pick !== 'a' && b.pick !== 'b') throw new BadRequestError('pick must be "a" or "b"');
    return { gameDate: parseGameDate(b.gameDate, now), round, pick: b.pick };
}

async function answer({ gameDate, round, pick }) {
    const game = await DailyGame.findOne({ gameDate }).select('rounds').lean();
    if (!game) throw new GameNotReadyError('That puzzle does not exist');
    const r = game.rounds[round];
    const correctPick = winnerOf(r);
    return { round, correct: pick === correctPick, answer: correctPick, a: { total: r.a.total }, b: { total: r.b.total } };
}

function parseResult(body, now = new Date()) {
    const b = body && typeof body === 'object' ? body : {};
    if (!Array.isArray(b.picks) || b.picks.length !== ROUNDS || !b.picks.every((p) => p === 'a' || p === 'b')) {
        throw new BadRequestError(`picks must be ${ROUNDS} entries of "a" or "b"`);
    }
    return { gameDate: parseGameDate(b.gameDate, now), picks: b.picks };
}

// The score is recomputed from the picks; the client never reports it.
async function submitResult(userId, { gameDate, picks }) {
    const game = await DailyGame.findOne({ gameDate }).select('rounds').lean();
    if (!game) throw new GameNotReadyError('That puzzle does not exist');
    const results = game.rounds.map((r, i) => picks[i] === winnerOf(r));
    const score = results.filter(Boolean).length;
    try {
        await GameResult.create({ userId, gameDate, picks, results, score });
        return { saved: true, score, results };
    } catch (error) {
        if (error && error.code === 11000) {
            const prior = await GameResult.findOne({ userId, gameDate }).lean();
            return { saved: false, alreadySubmitted: true, score: prior.score, results: prior.results };
        }
        throw error;
    }
}

// Streak = consecutive days played, ending today (or yesterday, so a streak
// isn't shown as broken before today's puzzle is played).
async function stats(userId, now = new Date()) {
    const rows = await GameResult.find({ userId }).sort({ gameDate: -1 }).limit(1000).select('gameDate score -_id').lean();
    const today = utcDate(now);
    const distribution = Array(ROUNDS + 1).fill(0);
    for (const r of rows) distribution[r.score] += 1;
    const dates = new Set(rows.map((r) => r.gameDate));

    let currentStreak = 0;
    let cursor = dates.has(today) ? today : shiftDate(today, -1);
    while (dates.has(cursor)) { currentStreak += 1; cursor = shiftDate(cursor, -1); }

    let maxStreak = 0;
    let run = 0;
    let prev = null;
    for (const d of [...dates].sort()) {
        run = prev && shiftDate(prev, 1) === d ? run + 1 : 1;
        maxStreak = Math.max(maxStreak, run);
        prev = d;
    }
    const todays = rows.find((r) => r.gameDate === today) || null;
    return {
        played: rows.length,
        currentStreak,
        maxStreak,
        best: rows.reduce((m, r) => Math.max(m, r.score), 0),
        distribution,
        today: todays ? { score: todays.score } : null,
    };
}

module.exports = {
    ROUNDS,
    BANDS,
    GameNotReadyError,
    utcDate,
    shiftDate,
    baseName,
    generateRounds,
    ensureGame,
    publicGame,
    parseAnswer,
    answer,
    parseResult,
    submitResult,
    stats,
};
