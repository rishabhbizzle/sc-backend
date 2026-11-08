'use strict';

// Nightly "insights" pass: after the cron has written the day's numbers, turn
// every song / album / artist's daily history into one precomputed snapshot
// (latest daily, % change, 7-day average, next milestone + ETA) and record
// milestone / record events. Feature routes read the snapshots, so nothing
// crunches history per request.

const Song = require('../models/songModel');
const Album = require('../models/albumModel');
const Artist = require('../models/artistModel');
const Insight = require('../models/insightModel');
const StreamEvent = require('../models/streamEventModel');
const streams = require('../utilities/streams');

const BATCH = 500;

const SOURCES = [
    { type: 'song', Model: Song, nameField: 'title', dailyField: 'dailyStreams', select: 'spotifyId title image artistSpotifyId totalStreams dailyStreams releaseDate' },
    { type: 'album', Model: Album, nameField: 'title', dailyField: 'dailyStreams', select: 'spotifyId title image artistSpotifyId totalStreams dailyStreams releaseDate' },
    { type: 'artist', Model: Artist, nameField: 'name', dailyField: 'dailyTotalStreams', select: 'spotifyId name image totalStreams dailyTotalStreams' },
];

// The newest data day across the tracked artists (every priority artist gets a
// key per successful run, so this is "the day the last run described").
async function latestDateKey() {
    let best = null;
    const cursor = Artist.find({}).select('dailyTotalStreams').lean().cursor();
    for await (const doc of cursor) {
        const last = streams.latest(streams.series(doc.dailyTotalStreams));
        if (last && (!best || last.date > best.date)) best = last;
    }
    return best ? best.key : null;
}

// Build one snapshot (+ events) for a document. Pure apart from its inputs, so
// it is unit-tested directly.
function buildSnapshot({ type, doc, nameField, dailyField, asOf, asOfKey, existing, artistNames }) {
    const total = typeof doc.totalStreams === 'number' ? doc.totalStreams : null;
    if (total == null) return null;
    const s = streams.series(doc[dailyField]);
    const last = streams.latest(s);
    // kworb regenerates artist pages at different times, so on a given run
    // some artists' newest day is one behind the others. Treat data up to a
    // day old as current, and date everything from the item's own data day.
    const lag = last ? streams.daysBetween(last.date, asOf) : null;
    const fresh = lag === 0 || lag === 1;
    const dayKey = fresh ? last.key : asOfKey;
    const day = fresh ? last.date : asOf;
    const daily = fresh ? last.value : null;

    // % change only against the immediately preceding day
    const prev = streams.previous(s);
    const prevIsYesterday = fresh && prev && streams.daysBetween(prev.date, last.date) === 1;
    const dailyChangePct = prevIsYesterday ? streams.pctChange(daily, prev.value) : null;

    const avg7 = fresh ? streams.avgDaily(s, day) : null;
    const next = streams.nextMilestone(type, total);
    const etaDays = next && fresh ? streams.etaDays(total, avg7, next.value) : null;

    // Where did today start? Re-running for the same day reuses the stored
    // start so the same crossings are found (events are idempotent anyway).
    let prevTotal;
    if (existing && existing.dateKey === dayKey && typeof existing.prevTotal === 'number') prevTotal = existing.prevTotal;
    else if (existing && typeof existing.total === 'number' && existing.dateKey !== dayKey) prevTotal = existing.total;
    else prevTotal = daily != null ? total - daily : total;

    const artistSpotifyId = type === 'artist' ? doc.spotifyId : doc.artistSpotifyId || null;
    const artistName = artistSpotifyId ? artistNames.get(artistSpotifyId) || null : null;

    const snapshot = {
        type,
        spotifyId: doc.spotifyId,
        name: doc[nameField] || null,
        image: doc.image || null,
        artistSpotifyId,
        artistName,
        releaseDate: doc.releaseDate || null,
        total,
        prevTotal,
        daily,
        dailyChangePct,
        avg7,
        nextMilestone: next ? next.value : null,
        major: next ? next.major : false,
        etaDays,
        etaDate: etaDays ? streams.addDays(day, etaDays) : null,
        dateKey: dayKey,
        date: day,
        stale: !fresh,
        historyDays: s.length,
        // first-7-days numbers, only for releases tracked from day one
        debut: type === 'artist' ? null : streams.debut(s, doc.releaseDate, { asOf: day }),
    };

    const events = [];
    if (fresh) {
        const base = {
            type, spotifyId: doc.spotifyId, dateKey: dayKey, date: day,
            name: snapshot.name, image: snapshot.image, artistSpotifyId, artistName,
        };
        // a jump of more than a few steps in one day means a data correction, not a real crossing
        const passed = streams.crossed(type, prevTotal, total);
        if (passed.length <= 3) {
            for (const value of passed) events.push({ ...base, kind: 'milestone', value, major: value % streams.BILLION === 0 });
        }
        if (streams.isRecord(s)) events.push({ ...base, kind: 'record', value: daily, major: false });
    }
    return { snapshot, events };
}

async function insertEvents(events) {
    if (!events.length) return 0;
    try {
        const res = await StreamEvent.insertMany(events, { ordered: false });
        return res.length;
    } catch (error) {
        // duplicates (same event from an earlier run) are expected; anything else is real
        const writeErrors = error && (error.writeErrors || (error.result && error.result.writeErrors)) || [];
        const nonDup = writeErrors.filter((e) => (e.code ?? (e.err && e.err.code)) !== 11000);
        if (!writeErrors.length || nonDup.length) throw error;
        return (error.insertedDocs && error.insertedDocs.length) || (error.result && error.result.insertedCount) || 0;
    }
}

async function computeInsights({ asOfKey } = {}) {
    const startedAt = Date.now();
    const key = asOfKey || (await latestDateKey());
    const asOf = key ? streams.parseKey(key) : null;
    if (!asOf) return { ok: false, reason: 'no daily data yet' };

    const artistNames = new Map(
        (await Artist.find({}).select('spotifyId name').lean()).map((a) => [a.spotifyId, a.name])
    );

    const stats = { ok: true, asOfKey: key };
    for (const { type, Model, nameField, dailyField, select } of SOURCES) {
        const existing = new Map(
            (await Insight.find({ type }).select('spotifyId total prevTotal dateKey').lean()).map((d) => [d.spotifyId, d])
        );
        const typeStats = { snapshots: 0, events: 0 };
        let ops = [];
        let events = [];
        const flush = async () => {
            if (ops.length) {
                await Insight.bulkWrite(ops, { ordered: false });
                typeStats.snapshots += ops.length;
            }
            typeStats.events += await insertEvents(events);
            ops = [];
            events = [];
        };

        const cursor = Model.find({}).select(select).lean().cursor();
        for await (const doc of cursor) {
            const built = buildSnapshot({ type, doc, nameField, dailyField, asOf, asOfKey: key, existing: existing.get(doc.spotifyId), artistNames });
            if (!built) continue;
            ops.push({ updateOne: { filter: { type, spotifyId: doc.spotifyId }, update: { $set: built.snapshot }, upsert: true } });
            events.push(...built.events);
            if (ops.length >= BATCH) await flush();
        }
        await flush();
        stats[type] = typeStats;
    }
    stats.durationMs = Date.now() - startedAt;
    return stats;
}

module.exports = { computeInsights, buildSnapshot, latestDateKey, insertEvents };
