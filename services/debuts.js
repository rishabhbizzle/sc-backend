'use strict';

// Debut wars (first-7-days leaderboards and head-to-heads), song/album races
// to a shared milestone, and a name search over tracked items for the pickers.

const Insight = require('../models/insightModel');
const Song = require('../models/songModel');
const Album = require('../models/albumModel');
const Artist = require('../models/artistModel');
const { BadRequestError } = require('../utilities/errors');
const streams = require('../utilities/streams');

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const first = (v) => (Array.isArray(v) ? v[0] : v);
const ITEM_FIELDS = 'type spotifyId name image artistSpotifyId artistName releaseDate total daily avg7 nextMilestone etaDays dateKey debut -_id';

function parseType(value, allowed) {
    const v = first(value) || allowed[0];
    if (!allowed.includes(v)) throw new BadRequestError(`type must be one of ${allowed.join(', ')}`);
    return v;
}

function parseLimit(value, fallback = 50, max = 100) {
    const v = first(value);
    if (v == null || v === '') return fallback;
    if (!/^\d+$/.test(String(v)) || +v < 1 || +v > max) throw new BadRequestError(`limit must be between 1 and ${max}`);
    return +v;
}

function parseIds(value, { min = 2, max = 4 } = {}) {
    const raw = first(value);
    const ids = typeof raw === 'string' ? [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))] : [];
    if (ids.length < min || ids.length > max || !ids.every((id) => SPOTIFY_ID_RE.test(id))) {
        throw new BadRequestError(`ids must be ${min}-${max} comma-separated Spotify ids`);
    }
    return ids;
}

// --- debut wars ------------------------------------------------------------

const parseDebuts = (q) => {
    const status = first(q.status) || 'complete';
    if (!['complete', 'live'].includes(status)) throw new BadRequestError('status must be complete or live');
    return { type: parseType(q.type, ['album', 'song']), status, limit: parseLimit(q.limit) };
};

// complete: finished first weeks, biggest first. live: releases still inside
// their first 7 days, newest first.
function debuts({ type, status, limit }) {
    if (status === 'live') {
        return Insight.find({ type, 'debut.complete': false, 'debut.daysCounted': { $lt: 7 } })
            .select(ITEM_FIELDS).sort({ 'debut.releaseDate': -1, 'debut.total': -1 }).limit(limit).lean();
    }
    return Insight.find({ type, 'debut.complete': true }).select(ITEM_FIELDS).sort({ 'debut.total': -1 }).limit(limit).lean();
}

const parseCompare = (q) => ({ type: parseType(q.type, ['album', 'song']), ids: parseIds(q.ids) });

// Items in the order asked; ones without debut data come back with debut: null
// so the page can say why.
async function compareDebuts({ type, ids }) {
    const rows = await Insight.find({ type, spotifyId: { $in: ids } }).select(ITEM_FIELDS).lean();
    const byId = new Map(rows.map((r) => [r.spotifyId, r]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
}

// --- races -----------------------------------------------------------------

const MODELS = {
    song: { Model: Song, field: 'dailyStreams' },
    album: { Model: Album, field: 'dailyStreams' },
    artist: { Model: Artist, field: 'dailyTotalStreams' },
};

const parseRace = (q) => ({ type: parseType(q.type, ['song', 'album', 'artist']), ids: parseIds(q.ids, { min: 2, max: 2 }) });

// Two items racing to the next milestone neither has reached yet, with each
// one's ETA at its recent pace and the last 60 days of cumulative totals.
async function race({ type, ids }) {
    const { Model, field } = MODELS[type];
    const [docs, insights] = await Promise.all([
        Model.find({ spotifyId: { $in: ids } }).select(`spotifyId totalStreams ${field}`).lean(),
        Insight.find({ type, spotifyId: { $in: ids } }).select(ITEM_FIELDS).lean(),
    ]);
    const docById = new Map(docs.map((d) => [d.spotifyId, d]));
    const insightById = new Map(insights.map((i) => [i.spotifyId, i]));
    if (!ids.every((id) => docById.has(id) && insightById.has(id))) return null;

    const totals = ids.map((id) => insightById.get(id).total);
    const milestone = streams.nextMilestone(type, Math.max(...totals)).value;
    const racers = ids.map((id) => {
        const ins = insightById.get(id);
        const s = streams.series(docById.get(id)[field]);
        const last = streams.latest(s);
        const history = [];
        if (last) {
            for (let k = 59; k >= 0; k--) {
                const date = streams.addDays(last.date, -k);
                const total = streams.totalAt(ins.total, s, date);
                if (total != null) history.push({ dateKey: streams.formatKey(date), total });
            }
        }
        const etaDays = streams.etaDays(ins.total, ins.avg7, milestone);
        return {
            ...ins,
            etaDaysToMilestone: etaDays,
            etaDateToMilestone: etaDays && last ? streams.addDays(last.date, etaDays) : null,
            history,
        };
    });
    const etas = racers.map((r) => r.etaDaysToMilestone);
    let leader = null;
    if (etas.every((e) => typeof e === 'number')) leader = etas[0] === etas[1] ? null : racers[etas[0] < etas[1] ? 0 : 1].spotifyId;
    else if (typeof etas[0] === 'number') leader = racers[0].spotifyId;
    else if (typeof etas[1] === 'number') leader = racers[1].spotifyId;
    return { type, milestone, leader, racers };
}

// --- search over tracked items (pickers) ----------------------------------------

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseSearch(q) {
    const term = typeof first(q.q) === 'string' ? first(q.q).trim() : '';
    if (term.length < 2 || term.length > 60) throw new BadRequestError('q must be 2-60 characters');
    const debutOnly = ['1', 'true'].includes(String(first(q.debut) || ''));
    return { type: parseType(q.type, ['song', 'album', 'artist']), q: term, limit: parseLimit(q.limit, 10, 25), debutOnly };
}

function search({ type, q, limit, debutOnly }) {
    const filter = { type, name: { $regex: escapeRegex(q), $options: 'i' } };
    if (debutOnly) filter['debut.day1'] = { $ne: null };
    return Insight.find(filter).select(ITEM_FIELDS).sort({ total: -1 }).limit(limit).lean();
}

module.exports = { parseDebuts, debuts, parseCompare, compareDebuts, parseRace, race, parseSearch, search };
