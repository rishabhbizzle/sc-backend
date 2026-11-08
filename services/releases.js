'use strict';

// Release countdowns and the day-one tracker.
//
// Source: the unofficial t4ils mirror of Spotify's artist overview, which the
// artist page already uses. Two fields matter:
//   preRelease          - an announced, not-yet-released album/single
//   discography.latest  - the newest release (verified shape: {id, name, type,
//                         coverArt.sources[], date: {year, month, day, precision}})
// No tracked artist had a pre-release when this was written, so its parser
// follows Spotify's GraphQL shape and accepts a couple of variants; anything
// it can't read is skipped, never stored half-parsed.

const axios = require('axios');
const Release = require('../models/releaseModel');
const PriorityArtist = require('../models/priorityArtists');
const Insight = require('../models/insightModel');
const { BadRequestError } = require('../utilities/errors');
const { DAY_MS } = require('../utilities/streams');

const T4ILS_URL = () => (process.env.T4ILS_API_URL || 'https://api.t4ils.dev').replace(/\/+$/, '');
const TIMEOUT_MS = 10000;
const ALBUM_URI_RE = /^spotify:album:([A-Za-z0-9]{22})$/;
const PRERELEASE_URI_RE = /^spotify:prerelease:([A-Za-z0-9]+)$/;

// largest image from [{url, width}] (Spotify GraphQL) or [{url}] (Web API)
function pickImage(sources) {
    if (!Array.isArray(sources)) return null;
    const usable = sources.filter((s) => s && typeof s.url === 'string' && /^https:\/\//.test(s.url));
    if (!usable.length) return null;
    return usable.reduce((best, s) => ((s.width || 0) > (best.width || 0) ? s : best)).url;
}

const validDate = (value) => {
    const d = value ? new Date(value) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
};

const cleanText = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// -> { releaseKey, albumId, name, type, coverUrl, releaseDate } | null
function normalizePreRelease(pre) {
    if (!pre || typeof pre !== 'object') return null;
    const content = pre.preReleaseContent || pre.content || pre;
    const name = cleanText(content.name);
    const releaseDate = validDate(
        (pre.releaseDate && (pre.releaseDate.isoString || pre.releaseDate.isoDate))
        || (typeof pre.releaseDate === 'string' ? pre.releaseDate : null)
        || (content.releaseDate && content.releaseDate.isoString)
    );
    if (!name || !releaseDate) return null;
    const albumMatch = ALBUM_URI_RE.exec(content.uri || '');
    const preMatch = PRERELEASE_URI_RE.exec(pre.uri || '');
    const releaseKey = albumMatch ? albumMatch[1] : preMatch ? `prerelease:${preMatch[1]}` : null;
    if (!releaseKey) return null;
    return {
        releaseKey,
        albumId: albumMatch ? albumMatch[1] : null,
        name,
        type: cleanText(content.type, 20),
        coverUrl: pickImage((content.coverArt && content.coverArt.sources) || content.images),
        releaseDate,
    };
}

// discography.latest -> same shape; only day-precision dates are usable
function normalizeLatest(latest) {
    if (!latest || typeof latest !== 'object') return null;
    const id = typeof latest.id === 'string' && /^[A-Za-z0-9]{22}$/.test(latest.id) ? latest.id : (ALBUM_URI_RE.exec(latest.uri || '') || [])[1];
    const name = cleanText(latest.name);
    const d = latest.date || {};
    if (!id || !name || d.precision !== 'DAY' || !d.year || !d.month || !d.day) return null;
    const releaseDate = new Date(Date.UTC(d.year, d.month - 1, d.day));
    if (Number.isNaN(releaseDate.getTime())) return null;
    return { releaseKey: id, albumId: id, name, type: cleanText(latest.type, 20), coverUrl: pickImage(latest.coverArt && latest.coverArt.sources), releaseDate };
}

async function fetchArtistUnion(artistId) {
    const res = await axios.get(`${T4ILS_URL()}/getArtist`, { params: { id: artistId }, timeout: TIMEOUT_MS, validateStatus: () => true });
    if (res.status !== 200) throw new Error(`t4ils ${res.status}`);
    return res.data && res.data.data && res.data.data.data && res.data.data.data.artistUnion || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Refresh releases for every tracked artist. One artist failing (t4ils is an
// unofficial mirror) never stops the rest.
async function refreshReleases({ fetchArtist = fetchArtistUnion, delayMs = 500, now = new Date() } = {}) {
    const artists = await PriorityArtist.find({}).select('spotifyId').lean();
    const stats = { artists: artists.length, ok: 0, failed: 0, upserted: 0, pruned: 0 };
    for (const [i, { spotifyId }] of artists.entries()) {
        try {
            const union = await fetchArtist(spotifyId);
            if (!union) throw new Error('no artist data');
            const artistName = cleanText(union.profile && union.profile.name);
            const artistImage = pickImage(union.visuals && union.visuals.avatarImage && union.visuals.avatarImage.sources);
            const items = [
                [normalizePreRelease(union.preRelease), 'preRelease'],
                [normalizeLatest(union.discography && union.discography.latest), 'latest'],
            ].filter(([r]) => r && r.releaseDate >= new Date(now.getTime() - 30 * DAY_MS));
            for (const [r, source] of items) {
                await Release.updateOne(
                    { releaseKey: r.releaseKey },
                    { $set: { ...r, artistSpotifyId: spotifyId, artistName, artistImage, source } },
                    { upsert: true }
                );
                stats.upserted += 1;
            }
            // a pre-release that has now come out under its album id replaces the placeholder
            const albumIds = items.map(([r]) => r.albumId).filter(Boolean);
            if (albumIds.length) await Release.deleteMany({ artistSpotifyId: spotifyId, releaseKey: /^prerelease:/, albumId: { $in: albumIds } });
            stats.ok += 1;
        } catch (error) {
            stats.failed += 1;
            console.warn(`[releases] ${spotifyId}: ${error && error.message}`);
        }
        if (delayMs && i < artists.length - 1) await sleep(delayMs);
    }
    stats.pruned = (await Release.deleteMany({ releaseDate: { $lt: new Date(now.getTime() - 30 * DAY_MS) } })).deletedCount;
    return stats;
}

const FIELDS = 'releaseKey albumId artistSpotifyId artistName artistImage name type coverUrl releaseDate -_id';

function parseReleases(q) {
    const status = (Array.isArray(q.status) ? q.status[0] : q.status) || 'upcoming';
    if (!['upcoming', 'out'].includes(status)) throw new BadRequestError('status must be upcoming or out');
    return { status };
}

// upcoming: not out yet, soonest first. out: released in the last 7 days,
// newest first, each with its day-one numbers so far (when we track it) and
// the artist's previous complete debut to compare against.
async function listReleases({ status }, now = new Date()) {
    if (status === 'upcoming') {
        return Release.find({ releaseDate: { $gt: now } }).select(FIELDS).sort({ releaseDate: 1 }).limit(50).lean();
    }
    const out = await Release.find({ releaseDate: { $lte: now, $gte: new Date(now.getTime() - 7 * DAY_MS) } })
        .select(FIELDS).sort({ releaseDate: -1 }).limit(50).lean();
    return Promise.all(out.map(async (r) => {
        const [tracked, previous] = await Promise.all([
            r.albumId ? Insight.findOne({ type: 'album', spotifyId: r.albumId }).select('spotifyId total daily debut -_id').lean() : null,
            Insight.findOne({ type: 'album', artistSpotifyId: r.artistSpotifyId, 'debut.complete': true, spotifyId: { $ne: r.albumId } })
                .sort({ 'debut.releaseDate': -1 }).select('spotifyId name image debut -_id').lean(),
        ]);
        return { ...r, tracked: tracked || null, previousDebut: previous || null };
    }));
}

module.exports = { normalizePreRelease, normalizeLatest, pickImage, refreshReleases, parseReleases, listReleases, fetchArtistUnion };
