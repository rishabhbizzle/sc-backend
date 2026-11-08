'use strict';

// Read side of the insights: milestone lists and single snapshots. Inputs are
// validated and normalised here (BadRequestError -> 400) so route cache keys
// are built from clean values only.

const Insight = require('../models/insightModel');
const StreamEvent = require('../models/streamEventModel');
const { BadRequestError } = require('../utilities/errors');
const { HUNDRED_MILLION, DAY_MS } = require('../utilities/streams');

const TYPES = ['song', 'album', 'artist'];
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;

// fields exposed to clients (no internal bookkeeping like prevTotal)
const PUBLIC_FIELDS = 'type spotifyId name image artistSpotifyId artistName releaseDate total daily dailyChangePct avg7 nextMilestone major etaDays etaDate dateKey stale -_id';
const EVENT_FIELDS = 'type spotifyId kind value major dateKey date name image artistSpotifyId artistName -_id';

const first = (v) => (Array.isArray(v) ? v[0] : v);

function parseType(value, { required = true } = {}) {
    const v = first(value);
    if (v == null || v === '') {
        if (required) throw new BadRequestError(`type must be one of ${TYPES.join(', ')}`);
        return null;
    }
    if (!TYPES.includes(v)) throw new BadRequestError(`type must be one of ${TYPES.join(', ')}`);
    return v;
}

function parseIntParam(value, name, { min, max, fallback }) {
    const v = first(value);
    if (v == null || v === '') return fallback;
    if (!/^\d+$/.test(String(v))) throw new BadRequestError(`${name} must be a whole number`);
    const n = Number(v);
    if (n < min || n > max) throw new BadRequestError(`${name} must be between ${min} and ${max}`);
    return n;
}

const parseBool = (value) => ['1', 'true'].includes(String(first(value) || '').toLowerCase());

function parseSpotifyId(value) {
    const v = first(value);
    if (typeof v !== 'string' || !SPOTIFY_ID_RE.test(v)) throw new BadRequestError('Invalid id');
    return v;
}

// --- parsers (exported so server.js can build cache keys from clean values)

const parseUpcoming = (q) => ({
    type: parseType(q.type),
    within: parseIntParam(q.within, 'within', { min: 1, max: 365, fallback: 30 }),
    limit: parseIntParam(q.limit, 'limit', { min: 1, max: 100, fallback: 50 }),
    major: parseBool(q.major),
});

function parseClub(q) {
    const type = parseType(q.type);
    const milestone = parseIntParam(q.milestone, 'milestone', { min: HUNDRED_MILLION, max: 1_000_000_000_000, fallback: 1_000_000_000 });
    if (milestone % HUNDRED_MILLION !== 0) throw new BadRequestError('milestone must be a multiple of 100,000,000');
    return { type, milestone, limit: parseIntParam(q.limit, 'limit', { min: 1, max: 100, fallback: 50 }) };
}

const parseRecent = (q) => ({
    type: parseType(q.type, { required: false }),
    days: parseIntParam(q.days, 'days', { min: 1, max: 30, fallback: 7 }),
    limit: parseIntParam(q.limit, 'limit', { min: 1, max: 100, fallback: 50 }),
    major: parseBool(q.major),
});

const parseInsight = (params) => ({ type: parseType(params.type), id: parseSpotifyId(params.id) });

// --- queries

// Soonest milestones within `within` days.
function upcoming({ type, within, limit, major }) {
    const filter = { type, stale: false, etaDays: { $gte: 1, $lte: within } };
    if (major) filter.major = true;
    return Insight.find(filter).select(PUBLIC_FIELDS).sort({ etaDays: 1, total: -1 }).limit(limit).lean();
}

// "Next to join the club": items still below `milestone`, by projected days to it.
async function club({ type, milestone, limit }) {
    const rows = await Insight.aggregate([
        { $match: { type, stale: false, total: { $lt: milestone }, avg7: { $gt: 0 } } },
        { $addFields: { clubEtaDays: { $max: [1, { $ceil: { $divide: [{ $subtract: [milestone, '$total'] }, '$avg7'] } }] } } },
        { $sort: { clubEtaDays: 1, total: -1 } },
        { $limit: limit },
        { $project: { _id: 0, prevTotal: 0, __v: 0, createdAt: 0, updatedAt: 0, historyDays: 0 } },
    ]);
    // `date` is the data day the snapshot describes; the projection counts from it
    return rows.map(({ date, ...r }) => ({ ...r, milestone, clubEtaDate: date ? new Date(new Date(date).getTime() + r.clubEtaDays * DAY_MS) : null }));
}

// Milestones crossed in the last `days` data days (anchored on the newest event,
// since data lags the calendar by a day or two).
async function recent({ type, days, limit, major }) {
    const newest = await StreamEvent.findOne({ kind: 'milestone' }).sort({ date: -1 }).select('date').lean();
    if (!newest) return [];
    const filter = { kind: 'milestone', date: { $gte: new Date(newest.date.getTime() - (days - 1) * DAY_MS) } };
    if (type) filter.type = type;
    if (major) filter.major = true;
    return StreamEvent.find(filter).select(EVENT_FIELDS).sort({ date: -1, value: -1 }).limit(limit).lean();
}

function getInsight({ type, id }) {
    return Insight.findOne({ type, spotifyId: id }).select(PUBLIC_FIELDS).lean();
}

module.exports = {
    TYPES,
    parseUpcoming,
    parseClub,
    parseRecent,
    parseInsight,
    upcoming,
    club,
    recent,
    getInsight,
};
