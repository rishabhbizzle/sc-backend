'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const Song = require('../models/songModel');
const Album = require('../models/albumModel');
const Artist = require('../models/artistModel');
const Insight = require('../models/insightModel');
const StreamEvent = require('../models/streamEventModel');
const { computeInsights, buildSnapshot, latestDateKey } = require('../services/insights');
const milestones = require('../services/milestones');
const s = require('../utilities/streams');

// ids must look like Spotify ids (22 base62 chars)
const id = (tag) => tag.padEnd(22, '0').slice(0, 22);
const ART = id('ARTIST');

// `days` consecutive keys ending at `endKey`, with the given per-day values
function history(endKey, values) {
    const end = s.parseKey(endKey);
    return Object.fromEntries(values.map((v, i) => [s.formatKey(s.addDays(end, i - values.length + 1)), v]));
}

let mongod;
test.before(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'insightstest' });
    await Promise.all([Insight.syncIndexes(), StreamEvent.syncIndexes()]);
});
test.after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});
test.beforeEach(async () => {
    await Promise.all([Song, Album, Artist, Insight, StreamEvent].map((M) => M.deleteMany({})));
});

test('buildSnapshot: daily, % change, 7-day average, next milestone and ETA', () => {
    const asOfKey = '10-11-2026';
    const doc = {
        spotifyId: id('SONG'), title: 'Cruel Summer', image: 'img', artistSpotifyId: ART, releaseDate: '2019-08-23',
        totalStreams: 2_950_000_000,
        dailyStreams: history(asOfKey, [4_000_000, 4_000_000, 4_000_000, 4_000_000, 4_000_000, 4_000_000, 4_000_000, 4_400_000]),
    };
    const { snapshot, events } = buildSnapshot({ type: 'song', doc, nameField: 'title', dailyField: 'dailyStreams', asOf: s.parseKey(asOfKey), asOfKey, existing: null, artistNames: new Map([[ART, 'Taylor Swift']]) });
    assert.equal(snapshot.daily, 4_400_000);
    assert.equal(snapshot.dailyChangePct, 10);
    // last 7 days: six 4.0M + one 4.4M
    assert.equal(snapshot.avg7, Math.round((6 * 4_000_000 + 4_400_000) / 7));
    assert.equal(snapshot.nextMilestone, 3_000_000_000);
    assert.equal(snapshot.major, true);
    assert.equal(snapshot.etaDays, Math.ceil(50_000_000 / snapshot.avg7));
    assert.equal(snapshot.etaDate.toISOString(), s.addDays(s.parseKey(asOfKey), snapshot.etaDays).toISOString());
    assert.equal(snapshot.artistName, 'Taylor Swift');
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.prevTotal, 2_950_000_000 - 4_400_000, 'first ever snapshot starts the day at total - daily');
    assert.deepEqual(events, []);
});

test('buildSnapshot: an item missing the latest day is stale with no daily/ETA/events', () => {
    const doc = { spotifyId: id('OLD'), title: 'Old', totalStreams: 999_999_000, dailyStreams: history('08-11-2026', [5, 5, 5, 5]) };
    const { snapshot, events } = buildSnapshot({ type: 'song', doc, nameField: 'title', dailyField: 'dailyStreams', asOf: s.parseKey('10-11-2026'), asOfKey: '10-11-2026', existing: { total: 999_000_000, dateKey: '09-11-2026' }, artistNames: new Map() });
    assert.equal(snapshot.stale, true);
    assert.equal(snapshot.daily, null);
    assert.equal(snapshot.etaDays, null);
    assert.deepEqual(events, [], 'no crossing is reported for an item that has no new data');
});

test('buildSnapshot: an item one day behind (kworb page not regenerated yet) is still current, dated from its own day', () => {
    const doc = { spotifyId: id('LAG'), title: 'Lag', totalStreams: 950_000_000, dailyStreams: history('09-11-2026', [2e6, 2e6, 2e6, 2e6]) };
    const { snapshot } = buildSnapshot({ type: 'song', doc, nameField: 'title', dailyField: 'dailyStreams', asOf: s.parseKey('10-11-2026'), asOfKey: '10-11-2026', existing: null, artistNames: new Map() });
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.daily, 2e6);
    assert.equal(snapshot.dateKey, '09-11-2026');
    assert.equal(snapshot.etaDays, 25);
    assert.equal(snapshot.etaDate.toISOString(), s.addDays(s.parseKey('09-11-2026'), 25).toISOString());
});

test('buildSnapshot: no total -> skipped; % change only vs the day right before', () => {
    const base = { type: 'song', nameField: 'title', dailyField: 'dailyStreams', asOf: s.parseKey('10-11-2026'), asOfKey: '10-11-2026', existing: null, artistNames: new Map() };
    assert.equal(buildSnapshot({ ...base, doc: { spotifyId: id('X'), dailyStreams: {} } }), null);
    const gap = buildSnapshot({ ...base, doc: { spotifyId: id('G'), totalStreams: 5, dailyStreams: { '07-11-2026': 1, '10-11-2026': 2 } } });
    assert.equal(gap.snapshot.dailyChangePct, null);
});

test('computeInsights: snapshots for all three types, milestone events from yesterday\'s snapshot, idempotent re-runs', async () => {
    await Artist.create({ spotifyId: ART, name: 'Taylor Swift', totalStreams: 99_990_000_000, dailyTotalStreams: history('09-11-2026', [50_000_000, 50_000_000, 50_000_000]) });
    await Song.create({ spotifyId: id('CRUEL'), title: 'Cruel Summer', artistSpotifyId: ART, totalStreams: 2_998_000_000, dailyStreams: history('09-11-2026', [4e6, 4e6, 4e6]) });
    await Album.create({ spotifyId: id('LOVER'), title: 'Lover', artistSpotifyId: ART, totalStreams: 9_010_000_000, dailyStreams: history('09-11-2026', [3e6, 3e6, 3e6]) });

    assert.equal(await latestDateKey(), '09-11-2026');
    const day1 = await computeInsights();
    assert.equal(day1.ok, true);
    assert.equal(day1.asOfKey, '09-11-2026');
    assert.deepEqual([day1.song.snapshots, day1.album.snapshots, day1.artist.snapshots], [1, 1, 1]);
    assert.equal(await StreamEvent.countDocuments(), 0, 'nothing crossed on day 1');

    // next day: song passes 3B, artist passes 100B
    await Song.updateOne({ spotifyId: id('CRUEL') }, { $set: { totalStreams: 3_002_000_000, 'dailyStreams.10-11-2026': 4e6 } });
    await Artist.updateOne({ spotifyId: ART }, { $set: { totalStreams: 100_040_000_000, 'dailyTotalStreams.10-11-2026': 50e6 } });
    await Album.updateOne({ spotifyId: id('LOVER') }, { $set: { totalStreams: 9_013_000_000, 'dailyStreams.10-11-2026': 3e6 } });
    const day2 = await computeInsights({ asOfKey: '10-11-2026' });
    assert.equal(day2.song.events, 1);
    assert.equal(day2.artist.events, 1);
    const events = await StreamEvent.find({}).sort({ type: 1 }).lean();
    assert.deepEqual(events.map((e) => [e.type, e.kind, e.value, e.major, e.dateKey, e.artistName]), [
        ['artist', 'milestone', 100_000_000_000, true, '10-11-2026', 'Taylor Swift'],
        ['song', 'milestone', 3_000_000_000, true, '10-11-2026', 'Taylor Swift'],
    ]);
    const snap = await Insight.findOne({ type: 'song' }).lean();
    assert.equal(snap.prevTotal, 2_998_000_000, 'the day starts from yesterday\'s snapshot');
    assert.equal(snap.nextMilestone, 3_100_000_000);

    // re-running the same day finds the same crossing and writes no duplicates
    const again = await computeInsights({ asOfKey: '10-11-2026' });
    assert.equal(again.song.events, 0);
    assert.equal(await StreamEvent.countDocuments(), 2);
    assert.equal((await Insight.findOne({ type: 'song' }).lean()).prevTotal, 2_998_000_000);
    assert.equal(await Insight.countDocuments(), 3);
});

test('computeInsights: a huge one-day jump (data correction) is not reported as a crossing; empty DB is a no-op', async () => {
    assert.deepEqual(await computeInsights(), { ok: false, reason: 'no daily data yet' });
    await Artist.create({ spotifyId: ART, name: 'A', totalStreams: 1, dailyTotalStreams: history('09-11-2026', [1]) });
    await Song.create({ spotifyId: id('FIX'), title: 'Fix', artistSpotifyId: ART, totalStreams: 910_000_000, dailyStreams: history('09-11-2026', [1e6]) });
    await computeInsights();
    await Song.updateOne({ spotifyId: id('FIX') }, { $set: { totalStreams: 1_500_000_000, 'dailyStreams.10-11-2026': 1e6 } });
    await Artist.updateOne({ spotifyId: ART }, { $set: { 'dailyTotalStreams.10-11-2026': 1 } });
    await computeInsights({ asOfKey: '10-11-2026' });
    assert.equal(await StreamEvent.countDocuments({ kind: 'milestone' }), 0);
});

test('computeInsights: daily records need 30+ days of history', async () => {
    const values = Array.from({ length: 30 }, (_, i) => 1_000_000 + i);
    await Artist.create({ spotifyId: ART, name: 'A', totalStreams: 5, dailyTotalStreams: history('30-11-2026', [1]) });
    await Song.create({ spotifyId: id('REC'), title: 'Rec', artistSpotifyId: ART, totalStreams: 50_000_000, dailyStreams: history('30-11-2026', values) });
    await computeInsights();
    const rec = await StreamEvent.findOne({ kind: 'record' }).lean();
    assert.equal(rec.value, 1_000_029);
    assert.equal(rec.spotifyId, id('REC'));
});

test('milestone queries: upcoming / club / recent / single insight, with validation', async () => {
    await Artist.create({ spotifyId: ART, name: 'Taylor Swift', totalStreams: 10, dailyTotalStreams: history('10-11-2026', [1, 1, 1]) });
    const mk = (tag, total, daily) => Song.create({ spotifyId: id(tag), title: tag, artistSpotifyId: ART, totalStreams: total, dailyStreams: history('10-11-2026', [daily, daily, daily]) });
    await mk('SOON', 2_990_000_000, 5_000_000);  // 3B in 2 days (major)
    await mk('LATER', 950_000_000, 2_000_000);   // 1B in 25 days (major)
    await mk('MINOR', 410_000_000, 1_000_000);   // 500M in 90 days
    await mk('FAST', 715_000_000, 10_000_000);   // 800M in 9 days, 1B in 29
    await computeInsights();

    const up = await milestones.upcoming(milestones.parseUpcoming({ type: 'song' }));
    assert.deepEqual(up.map((r) => r.name), ['SOON', 'FAST', 'LATER']);
    assert.equal(up[0].etaDays, 2);
    assert.equal(up[0].prevTotal, undefined, 'internal fields are not exposed');
    assert.equal(up[0]._id, undefined);
    const majors = await milestones.upcoming(milestones.parseUpcoming({ type: 'song', major: '1', within: '365' }));
    assert.deepEqual(majors.map((r) => r.name), ['SOON', 'LATER']);

    const club = await milestones.club(milestones.parseClub({ type: 'song', milestone: '1000000000' }));
    assert.deepEqual(club.map((r) => [r.name, r.clubEtaDays]), [['LATER', 25], ['FAST', 29], ['MINOR', 590]]);
    assert.equal(club[0].milestone, 1_000_000_000);
    assert.equal(club[0].clubEtaDate.toISOString(), s.addDays(s.parseKey('10-11-2026'), 25).toISOString());

    const one = await milestones.getInsight(milestones.parseInsight({ type: 'song', id: id('SOON') }));
    assert.equal(one.total, 2_990_000_000);
    assert.equal(await milestones.getInsight(milestones.parseInsight({ type: 'album', id: id('SOON') })), null);

    await StreamEvent.create([
        { type: 'song', spotifyId: id('A'), kind: 'milestone', value: 1e9, major: true, dateKey: '10-11-2026', date: s.parseKey('10-11-2026') },
        { type: 'song', spotifyId: id('B'), kind: 'milestone', value: 2e8, dateKey: '04-11-2026', date: s.parseKey('04-11-2026') },
        { type: 'album', spotifyId: id('C'), kind: 'milestone', value: 3e9, major: true, dateKey: '01-11-2026', date: s.parseKey('01-11-2026') },
        { type: 'song', spotifyId: id('D'), kind: 'record', value: 5e6, dateKey: '10-11-2026', date: s.parseKey('10-11-2026') },
    ]);
    const recent = await milestones.recent(milestones.parseRecent({}));
    assert.deepEqual(recent.map((e) => e.spotifyId), [id('A'), id('B')], 'last 7 data days, milestones only');
    const recentAlbums = await milestones.recent(milestones.parseRecent({ type: 'album', days: '30' }));
    assert.deepEqual(recentAlbums.map((e) => e.spotifyId), [id('C')]);

    const bad = [
        () => milestones.parseUpcoming({}),
        () => milestones.parseUpcoming({ type: 'podcast' }),
        () => milestones.parseUpcoming({ type: 'song', within: '0' }),
        () => milestones.parseUpcoming({ type: 'song', limit: '101' }),
        () => milestones.parseUpcoming({ type: 'song', limit: '5abc' }),
        () => milestones.parseClub({ type: 'song', milestone: '150000000' }),
        () => milestones.parseClub({ type: 'song', milestone: '99' }),
        () => milestones.parseRecent({ days: '31' }),
        () => milestones.parseInsight({ type: 'song', id: 'short' }),
        () => milestones.parseInsight({ type: 'song', id: { $ne: 1 } }),
    ];
    for (const fn of bad) assert.throws(fn, { name: 'BadRequestError' });
    assert.deepEqual(milestones.parseUpcoming({ type: ['song', 'album'] }), { type: 'song', within: 30, limit: 50, major: false }, 'repeated params use the first');
});
