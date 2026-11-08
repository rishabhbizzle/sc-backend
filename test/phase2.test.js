'use strict';
// Phase 2: Streamdle, release countdowns / day-one tracker, debut wars, races.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const Song = require('../models/songModel');
const Album = require('../models/albumModel');
const Artist = require('../models/artistModel');
const Insight = require('../models/insightModel');
const StreamEvent = require('../models/streamEventModel');
const DailyGame = require('../models/dailyGameModel');
const GameResult = require('../models/gameResultModel');
const Release = require('../models/releaseModel');
const PriorityArtist = require('../models/priorityArtists');
const s = require('../utilities/streams');
const streamdle = require('../services/streamdle');
const releases = require('../services/releases');
const debuts = require('../services/debuts');
const { computeInsights } = require('../services/insights');

const id = (tag) => tag.padEnd(22, '0').slice(0, 22);
const ART = id('ARTIST');
function history(endKey, values) {
    const end = s.parseKey(endKey);
    return Object.fromEntries(values.map((v, i) => [s.formatKey(s.addDays(end, i - values.length + 1)), v]));
}
// `count` songs with totals rising ~3% each from 100M: plenty of pairs in every band
function songPool(count = 200) {
    return Array.from({ length: count }, (_, i) => ({
        spotifyId: id(`S${i}X`), name: `Song ${i}`, artistName: `Artist ${i % 7}`, image: `https://i.scdn.co/${i}`, total: Math.round(1e8 * 1.03 ** i),
    }));
}

let mongod;
test.before(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'phase2test' });
    await Promise.all([Insight, StreamEvent, DailyGame, GameResult, Release].map((M) => M.syncIndexes()));
});
test.after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});
test.beforeEach(async () => {
    await Promise.all([Song, Album, Artist, Insight, StreamEvent, DailyGame, GameResult, Release, PriorityArtist].map((M) => M.deleteMany({})));
});

// --- debut maths -------------------------------------------------------------

test('streams.debut: needs day one; counts elapsed days; complete only with all 7 present', () => {
    const full = s.series(history('08-11-2026', [10, 9, 8, 7, 6, 5, 4, 3]));
    const d = s.debut(full, '2026-11-01');
    assert.deepEqual(d.days, [10, 9, 8, 7, 6, 5, 4]);
    assert.equal(d.total, 49);
    assert.equal(d.day1, 10);
    assert.equal(d.complete, true);
    assert.equal(d.daysCounted, 7);

    const live = s.debut(s.series({ '01-11-2026': 10, '02-11-2026': 9, '03-11-2026': 8 }), '2026-11-01');
    assert.deepEqual(live.days, [10, 9, 8, null, null, null, null]);
    assert.equal(live.daysCounted, 3);
    assert.equal(live.complete, false);

    const gap = s.debut(s.series({ '01-11-2026': 10, '02-11-2026': 9, '04-11-2026': 7, '05-11-2026': 6, '06-11-2026': 5, '07-11-2026': 4 }), '2026-11-01');
    assert.equal(gap.days[2], null);
    assert.equal(gap.complete, false, 'a missing day means no leaderboard spot');
    assert.equal(gap.total, 41);

    assert.equal(s.debut(s.series({ '02-11-2026': 9, '03-11-2026': 8 }), '2026-11-01'), null, 'tracking started after day one');
    assert.equal(s.debut(full, '2026-11'), null, 'month-precision dates are not enough');
    assert.equal(s.debut(full, undefined), null);
    assert.equal(s.debut([], '2026-11-01'), null);
});

// --- Streamdle ---------------------------------------------------------------

test('streamdle: same date -> same puzzle; 10 rounds that tighten; no song (or version of it) twice', () => {
    const pool = songPool();
    pool.push({ spotifyId: id('STYLE1'), name: 'Style', artistName: 'Taylor Swift', image: 'x', total: 2e9 });
    pool.push({ spotifyId: id('STYLE2'), name: "Style (Taylor's Version)", artistName: 'Taylor Swift', image: 'x', total: 1.9e9 });
    const a = streamdle.generateRounds('2026-11-12', pool);
    const b = streamdle.generateRounds('2026-11-12', [...pool].reverse());
    assert.deepEqual(a, b, 'input order does not change the puzzle');
    assert.notDeepEqual(streamdle.generateRounds('2026-11-13', pool), a, 'another day, another puzzle');
    assert.equal(a.length, 10);
    const bases = [];
    a.forEach((r, i) => {
        const ratio = Math.max(r.a.total, r.b.total) / Math.min(r.a.total, r.b.total);
        const [lo, hi] = streamdle.BANDS[i];
        assert.ok(ratio >= lo && ratio <= hi, `round ${i} ratio ${ratio.toFixed(2)} outside ${lo}-${hi}`);
        bases.push(streamdle.baseName(r.a.name), streamdle.baseName(r.b.name));
    });
    assert.equal(new Set(bases).size, 20, 'every song (counting versions as one) appears once');
    assert.equal(streamdle.baseName("Style (Taylor's Version) [From The Vault]"), 'style');
    assert.equal(streamdle.baseName('Die With A Smile - Live'), 'die with a smile');
    assert.throws(() => streamdle.generateRounds('2026-11-12', pool.slice(0, 3)), { name: 'GameNotReadyError' });
    assert.throws(() => streamdle.generateRounds('2026-11-12', pool.map((p) => ({ ...p, total: 5e7 }))), { name: 'GameNotReadyError' }, 'songs under 100M are not used');
});

test('streamdle: ensureGame stores one puzzle per day (also under concurrency) and avoids recent songs', async () => {
    await Insight.insertMany(songPool(300).map((p) => ({ type: 'song', ...p })));
    const [g1, g2] = await Promise.all([streamdle.ensureGame('2026-11-12'), streamdle.ensureGame('2026-11-12')]);
    assert.equal(await DailyGame.countDocuments(), 1);
    assert.deepEqual(g1.rounds, g2.rounds);
    assert.equal(g1.number, 1, 'the first puzzle ever is #1');
    const next = await streamdle.ensureGame('2026-11-13');
    assert.equal(next.number, 2);
    const used = new Set(g1.rounds.flatMap((r) => [r.a.spotifyId, r.b.spotifyId]));
    assert.ok(next.rounds.every((r) => !used.has(r.a.spotifyId) && !used.has(r.b.spotifyId)), 'yesterday\'s songs are not reused');
    const pub = streamdle.publicGame(g1);
    assert.equal(JSON.stringify(pub).includes('total'), false, 'the public puzzle carries no totals');
    assert.equal(pub.rounds[0].a.name, g1.rounds[0].a.name);
});

test('streamdle: answers, result scoring and validation', async () => {
    await Insight.insertMany(songPool().map((p) => ({ type: 'song', ...p })));
    const now = new Date('2026-11-12T10:00:00Z');
    const game = await streamdle.ensureGame('2026-11-12');
    const r0 = game.rounds[0];
    const right = r0.a.total > r0.b.total ? 'a' : 'b';
    const res = await streamdle.answer(streamdle.parseAnswer({ gameDate: '2026-11-12', round: 0, pick: right }, now));
    assert.deepEqual(res, { round: 0, correct: true, answer: right, a: { total: r0.a.total }, b: { total: r0.b.total } });
    const wrong = await streamdle.answer({ gameDate: '2026-11-12', round: 0, pick: right === 'a' ? 'b' : 'a' });
    assert.equal(wrong.correct, false);

    assert.doesNotThrow(() => streamdle.parseAnswer({ gameDate: '2026-11-11', round: 9, pick: 'a' }, now), 'yesterday is allowed');
    for (const bad of [
        { gameDate: '2026-11-10', round: 0, pick: 'a' },
        { gameDate: '2026-11-13', round: 0, pick: 'a' },
        { gameDate: '2026-11-12', round: 10, pick: 'a' },
        { gameDate: '2026-11-12', round: '1', pick: 'a' },
        { gameDate: '2026-11-12', round: 0, pick: 'c' },
        null,
    ]) assert.throws(() => streamdle.parseAnswer(bad, now), { name: 'BadRequestError' });
    await assert.rejects(streamdle.answer({ gameDate: '2026-11-11', round: 0, pick: 'a' }), { name: 'GameNotReadyError' });

    const picks = game.rounds.map((r) => (r.a.total > r.b.total ? 'a' : 'b'));
    picks[3] = picks[3] === 'a' ? 'b' : 'a';
    const saved = await streamdle.submitResult('user_1', streamdle.parseResult({ gameDate: '2026-11-12', picks, score: 10 }, now));
    assert.equal(saved.score, 9, 'score is recomputed server-side, the client value is ignored');
    assert.equal(saved.results[3], false);
    const again = await streamdle.submitResult('user_1', { gameDate: '2026-11-12', picks: game.rounds.map(() => 'a') });
    assert.deepEqual({ saved: again.saved, alreadySubmitted: again.alreadySubmitted, score: again.score }, { saved: false, alreadySubmitted: true, score: 9 }, 'first submission wins');
    assert.throws(() => streamdle.parseResult({ gameDate: '2026-11-12', picks: ['a'] }, now), { name: 'BadRequestError' });
    assert.throws(() => streamdle.parseResult({ gameDate: '2026-11-12', picks: Array(10).fill('x') }, now), { name: 'BadRequestError' });
});

test('streamdle: streaks, best score and distribution', async () => {
    const play = (gameDate, score) => GameResult.create({ userId: 'u', gameDate, picks: Array(10).fill('a'), results: [], score });
    await Promise.all([play('2026-11-01', 4), play('2026-11-02', 6), play('2026-11-03', 10), play('2026-11-05', 7), play('2026-11-06', 7)]);
    await GameResult.create({ userId: 'someone-else', gameDate: '2026-11-07', picks: [], results: [], score: 1 });
    const beforeToday = await streamdle.stats('u', new Date('2026-11-07T08:00:00Z'));
    assert.equal(beforeToday.currentStreak, 2, 'yesterday still counts while today is unplayed');
    assert.equal(beforeToday.maxStreak, 3);
    assert.equal(beforeToday.best, 10);
    assert.equal(beforeToday.played, 5);
    assert.equal(beforeToday.distribution[7], 2);
    assert.equal(beforeToday.today, null);
    const broken = await streamdle.stats('u', new Date('2026-11-08T08:00:00Z'));
    assert.equal(broken.currentStreak, 0);
    assert.deepEqual(await streamdle.stats('nobody'), { played: 0, currentStreak: 0, maxStreak: 0, best: 0, distribution: Array(11).fill(0), today: null });
});

// --- releases ----------------------------------------------------------------

const PRE = {
    preReleaseContent: {
        uri: `spotify:album:${id('NEWALBUM')}`, name: 'New Album', type: 'ALBUM',
        coverArt: { sources: [{ url: 'https://i.scdn.co/small', width: 300 }, { url: 'https://i.scdn.co/big', width: 640 }] },
    },
    releaseDate: { isoString: '2026-12-05T05:00:00Z' },
    uri: 'spotify:prerelease:abc123',
};
// shape observed live from t4ils discography.latest
const LATEST = {
    id: id('PATIENT'), uri: `spotify:album:${id('PATIENT')}`, name: 'Patient Zero', type: 'SINGLE',
    date: { year: 2026, month: 11, day: 6, precision: 'DAY' },
    coverArt: { sources: [{ url: 'https://i.scdn.co/300', width: 300 }, { url: 'https://i.scdn.co/640', width: 640 }] },
};

test('normalizePreRelease / normalizeLatest: parse the known shapes, reject what they cannot read', () => {
    assert.deepEqual(releases.normalizePreRelease(PRE), {
        releaseKey: id('NEWALBUM'), albumId: id('NEWALBUM'), name: 'New Album', type: 'ALBUM', coverUrl: 'https://i.scdn.co/big', releaseDate: new Date('2026-12-05T05:00:00Z'),
    });
    const noAlbum = releases.normalizePreRelease({ ...PRE, preReleaseContent: { ...PRE.preReleaseContent, uri: undefined } });
    assert.equal(noAlbum.releaseKey, 'prerelease:abc123');
    assert.equal(noAlbum.albumId, null);
    assert.equal(releases.normalizePreRelease({ ...PRE, releaseDate: 'not a date' }), null);
    assert.equal(releases.normalizePreRelease({ ...PRE, preReleaseContent: { ...PRE.preReleaseContent, name: '  ' } }), null);
    assert.equal(releases.normalizePreRelease({ preReleaseContent: { name: 'x' }, releaseDate: { isoString: '2026-12-05T05:00:00Z' } }), null, 'no usable id');
    assert.equal(releases.normalizePreRelease(null), null);
    assert.equal(releases.pickImage([{ url: 'javascript:alert(1)', width: 999 }, { url: 'https://i.scdn.co/ok', width: 1 }]), 'https://i.scdn.co/ok');

    assert.deepEqual(releases.normalizeLatest(LATEST), {
        releaseKey: id('PATIENT'), albumId: id('PATIENT'), name: 'Patient Zero', type: 'SINGLE', coverUrl: 'https://i.scdn.co/640', releaseDate: new Date('2026-11-06T00:00:00Z'),
    });
    assert.equal(releases.normalizeLatest({ ...LATEST, date: { year: 2026, precision: 'YEAR' } }), null);
    assert.equal(releases.normalizeLatest({ ...LATEST, id: 'bad', uri: 'nope' }), null);
});

test('refreshReleases: upserts per artist, survives a failing artist, replaces placeholders, prunes old ones', async () => {
    const A = id('ARTA'); const B = id('ARTB'); const C = id('ARTC');
    await PriorityArtist.create([{ spotifyId: A, cmId: '1' }, { spotifyId: B, cmId: '2' }, { spotifyId: C, cmId: '3' }]);
    const now = new Date('2026-11-08T12:00:00Z');
    await Release.create({ releaseKey: 'prerelease:abc123', albumId: id('NEWALBUM'), artistSpotifyId: A, name: 'New Album', releaseDate: new Date('2026-12-05'), source: 'preRelease' });
    await Release.create({ releaseKey: id('ANCIENT'), artistSpotifyId: B, name: 'Old', releaseDate: new Date('2026-09-01'), source: 'latest' });
    const unions = {
        [A]: { profile: { name: 'Artist A' }, visuals: { avatarImage: { sources: [{ url: 'https://i.scdn.co/a', width: 1 }] } }, preRelease: PRE, discography: { latest: LATEST } },
        [B]: { profile: { name: 'Artist B' }, preRelease: null, discography: { latest: { ...LATEST, id: id('OLDLATEST'), date: { year: 2026, month: 1, day: 1, precision: 'DAY' } } } },
    };
    const stats = await releases.refreshReleases({ fetchArtist: async (aid) => { if (aid === C) throw new Error('t4ils 500'); return unions[aid]; }, delayMs: 0, now });
    assert.deepEqual(stats, { artists: 3, ok: 2, failed: 1, upserted: 2, pruned: 1 });
    const docs = await Release.find({}).sort({ releaseDate: 1 }).lean();
    assert.deepEqual(docs.map((d) => [d.releaseKey, d.source, d.artistName]), [
        [id('PATIENT'), 'latest', 'Artist A'],
        [id('NEWALBUM'), 'preRelease', 'Artist A'],
    ], 'placeholder replaced by the album id, stale latest skipped, old one pruned');
    assert.equal(docs[1].artistImage, 'https://i.scdn.co/a');

    // re-running is idempotent
    await releases.refreshReleases({ fetchArtist: async (aid) => unions[aid] || null, delayMs: 0, now });
    assert.equal(await Release.countDocuments(), 2);
});

test('listReleases: upcoming soonest first; out = last 7 days with day-one numbers and the previous debut', async () => {
    const now = new Date('2026-11-08T12:00:00Z');
    await Release.create([
        { releaseKey: id('SOON'), albumId: id('SOON'), artistSpotifyId: ART, name: 'Soon', releaseDate: new Date('2026-11-20'), source: 'preRelease' },
        { releaseKey: id('SOONER'), albumId: id('SOONER'), artistSpotifyId: ART, name: 'Sooner', releaseDate: new Date('2026-11-10'), source: 'preRelease' },
        { releaseKey: id('OUT'), albumId: id('OUT'), artistSpotifyId: ART, name: 'Out', releaseDate: new Date('2026-11-06'), source: 'latest' },
        { releaseKey: id('OLDER'), albumId: id('OLDER'), artistSpotifyId: ART, name: 'Older', releaseDate: new Date('2026-10-20'), source: 'latest' },
    ]);
    await Insight.create([
        { type: 'album', spotifyId: id('OUT'), name: 'Out', artistSpotifyId: ART, total: 3e7, debut: { releaseDate: '2026-11-06', days: [2e7, 1e7, null, null, null, null, null], day1: 2e7, total: 3e7, daysCounted: 2, complete: false } },
        { type: 'album', spotifyId: id('PREV'), name: 'Prev', artistSpotifyId: ART, total: 9e8, debut: { releaseDate: '2025-05-01', days: [5e7, 4e7, 3e7, 3e7, 3e7, 3e7, 3e7], day1: 5e7, total: 2.5e8, daysCounted: 7, complete: true } },
        { type: 'album', spotifyId: id('PREVOLD'), name: 'Prev old', artistSpotifyId: ART, total: 9e8, debut: { releaseDate: '2023-05-01', days: [1, 1, 1, 1, 1, 1, 1], day1: 1, total: 7, daysCounted: 7, complete: true } },
    ]);
    const up = await releases.listReleases(releases.parseReleases({}), now);
    assert.deepEqual(up.map((r) => r.name), ['Sooner', 'Soon']);
    const out = await releases.listReleases(releases.parseReleases({ status: 'out' }), now);
    assert.deepEqual(out.map((r) => r.name), ['Out']);
    assert.equal(out[0].tracked.debut.day1, 2e7);
    assert.equal(out[0].previousDebut.name, 'Prev', 'the most recent complete debut by the same artist');
    assert.throws(() => releases.parseReleases({ status: 'past' }), { name: 'BadRequestError' });
});

// --- debut wars, races, search ---------------------------------------------------

test('insights compute debuts; leaderboards (complete / live), compare, race and search', async () => {
    await Artist.create({ spotifyId: ART, name: 'Taylor Swift', totalStreams: 5, dailyTotalStreams: history('10-11-2026', [1, 1, 1]) });
    // released 01-11, tracked from day one: complete week
    await Album.create({ spotifyId: id('BIG'), title: 'Big Debut', artistSpotifyId: ART, releaseDate: '2026-11-01', totalStreams: 5e8, dailyStreams: history('10-11-2026', [9e7, 8e7, 7e7, 6e7, 5e7, 4e7, 3e7, 2e7, 2e7, 2e7]) });
    await Album.create({ spotifyId: id('SMALL'), title: 'Small Debut', artistSpotifyId: ART, releaseDate: '2026-11-01', totalStreams: 1e8, dailyStreams: history('10-11-2026', [1e7, 1e7, 1e7, 1e7, 1e7, 1e7, 1e7, 1e7, 1e7, 1e7]) });
    // released 08-11: 3 days in
    await Album.create({ spotifyId: id('LIVE'), title: 'Live (Deluxe)', artistSpotifyId: ART, releaseDate: '2026-11-08', totalStreams: 6e7, dailyStreams: history('10-11-2026', [3e7, 2e7, 1e7]) });
    // old album, history doesn't reach release day
    await Album.create({ spotifyId: id('OLD'), title: 'Old', artistSpotifyId: ART, releaseDate: '2019-08-23', totalStreams: 9e9, dailyStreams: history('10-11-2026', [3e6, 3e6, 3e6]) });
    await Song.create({ spotifyId: id('RACEA'), title: 'Racer A', artistSpotifyId: ART, totalStreams: 950_000_000, dailyStreams: history('10-11-2026', Array(70).fill(2e6)) });
    await Song.create({ spotifyId: id('RACEB'), title: 'Racer B', artistSpotifyId: ART, totalStreams: 900_000_000, dailyStreams: history('10-11-2026', Array(70).fill(5e6)) });
    await Song.create({ spotifyId: id('REGEX'), title: 'Wh(.*)y?', artistSpotifyId: ART, totalStreams: 1e6, dailyStreams: history('10-11-2026', [1, 1, 1]) });
    await computeInsights();

    const complete = await debuts.debuts(debuts.parseDebuts({ type: 'album' }));
    assert.deepEqual(complete.map((d) => [d.name, d.debut.total]), [['Big Debut', 4.2e8], ['Small Debut', 7e7]]);
    assert.deepEqual(complete[0].debut.days, [9e7, 8e7, 7e7, 6e7, 5e7, 4e7, 3e7]);
    const live = await debuts.debuts(debuts.parseDebuts({ type: 'album', status: 'live' }));
    assert.deepEqual(live.map((d) => [d.name, d.debut.daysCounted, d.debut.total]), [['Live (Deluxe)', 3, 6e7]]);
    assert.equal((await Insight.findOne({ spotifyId: id('OLD') }).lean()).debut, null);

    const cmp = await debuts.compareDebuts(debuts.parseCompare({ type: 'album', ids: `${id('SMALL')},${id('BIG')},${id('NOPE')}` }));
    assert.deepEqual(cmp.map((d) => d.name), ['Small Debut', 'Big Debut'], 'requested order, unknown ids dropped');

    const r = await debuts.race(debuts.parseRace({ type: 'song', ids: `${id('RACEA')},${id('RACEB')}` }));
    assert.equal(r.milestone, 1e9, 'next milestone neither has reached');
    assert.deepEqual(r.racers.map((x) => x.etaDaysToMilestone), [25, 20]);
    assert.equal(r.leader, id('RACEB'));
    assert.equal(r.racers[0].history.length, 60);
    assert.equal(r.racers[0].history[59].total, 950_000_000);
    assert.equal(r.racers[0].history[58].total, 948_000_000);
    assert.equal(await debuts.race({ type: 'song', ids: [id('RACEA'), id('MISSING')] }), null);

    const found = await debuts.search(debuts.parseSearch({ type: 'song', q: 'racer' }));
    assert.deepEqual(found.map((x) => x.name), ['Racer A', 'Racer B']);
    const literal = await debuts.search(debuts.parseSearch({ type: 'song', q: '(.*)' }));
    assert.deepEqual(literal.map((x) => x.name), ['Wh(.*)y?'], 'regex characters are matched literally');
    const debutOnly = await debuts.search(debuts.parseSearch({ type: 'album', q: 'De', debut: '1' }));
    assert.ok(debutOnly.every((x) => x.debut && x.debut.day1), 'debut filter');
    assert.ok(!debutOnly.some((x) => x.name === 'Old'));

    for (const fn of [
        () => debuts.parseDebuts({ type: 'artist' }),
        () => debuts.parseDebuts({ status: 'old' }),
        () => debuts.parseCompare({ type: 'album', ids: id('A') }),
        () => debuts.parseCompare({ type: 'album', ids: 'x,y' }),
        () => debuts.parseRace({ ids: `${id('A')},${id('B')},${id('C')}` }),
        () => debuts.parseSearch({ q: 'a' }),
        () => debuts.parseSearch({ q: { $gt: '' } }),
    ]) assert.throws(fn, { name: 'BadRequestError' });
});
