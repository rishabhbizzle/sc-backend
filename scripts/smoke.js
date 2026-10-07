'use strict';
// Hits every public route and reports status, latency and payload shape.
//   node scripts/smoke.js                       # http://localhost:4000
//   node scripts/smoke.js https://api.statscrave.com
// Exits non-zero if any required route fails or returns an empty payload.
const base = (process.argv[2] || process.env.SMOKE_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const TS = '06HL4z0CvFAxyc27GXpf02';   // Taylor Swift
const TRACK = '1BxfuPKGuaTgP7aM0Bbdwr'; // Cruel Summer
const ALBUM = '1NAmidJlEaVgA3MpcPFYGq'; // Lover

const routes = [
    { path: '/', expect: 'object' },
    { path: '/api/v1/health', expect: 'object' },
    { path: `/api/v1/daily/songs/${TS}`, expect: 'array' },
    { path: `/api/v1/daily/albums/${TS}`, expect: 'array' },
    { path: `/api/v1/daily/overall/${TS}`, expect: 'array' },
    { path: `/api/v1/artist/streams/${TS}`, expect: 'object' },
    { path: `/api/v1/artist/social/${TS}`, expect: 'any' },
    { path: `/api/v1/artist/${TS}`, expect: 'object' },
    { path: `/api/v1/artist/popular/${TS}`, expect: 'array' },
    { path: `/api/v1/track/${TRACK}`, expect: 'object' },
    { path: `/api/v1/album/${ALBUM}`, expect: 'object' },
    { path: '/api/v1/others/mostStreamedArtists', expect: 'array' },
    { path: '/api/v1/others/mostMonthlyListeners', expect: 'array' },
    { path: '/api/v1/others/mostStreamedSongs', expect: 'array' },
    { path: '/api/v1/others/mostStreamedSongs?year=2023', expect: 'array' },
    { path: '/api/v1/others/mostStreamedAlbums', expect: 'array' },
    { path: '/api/v1/others/mostStreamedSongsInSingleDay', expect: 'array' },
    { path: '/api/v1/others/mostStreamedSongsInSingleDay?type=holiday', expect: 'array' },
    { path: '/api/v1/others/mostStreamedSongsInSingleWeek', expect: 'array' },
    { path: '/api/v1/others/mostStreamedAlbumsInSingle?mode=day', expect: 'array' },
    { path: '/api/v1/others/mostStreamedAlbumsInSingle?mode=week', expect: 'array' },
    { path: '/api/v1/youtube/mostViewedVideos', expect: 'array' },
    { path: '/api/v1/youtube/mostViewedVideos?year=2023', expect: 'array' },
    { path: '/api/v1/others/new-releases?limit=5', expect: 'object' },
    { path: '/api/v1/songs/top?limit=5', expect: 'object' },
    { path: '/api/v1/songs/viral?limit=5', expect: 'object', optional: true },
    { path: '/api/v1/charts/lastFmTopTracks?page=1&limit=5', expect: 'object' },
    { path: '/api/v1/charts/qqMusic?limit=5', expect: 'object' },
    { path: '/api/v1/search?type=artist&text=taylor', expect: 'object' },
    { path: '/api/v1/others/getRecomendations?type=artist', expect: 'array' },
    { path: `/api/v1/reviews?targetId=${TS}`, expect: 'any' },
    { path: '/api/v1/user/favourites/smoke-test-user', expect: 'object' },
];

function describe(payload) {
    const d = payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
    if (d === null || d === undefined) return { kind: 'null', text: 'null' };
    if (Array.isArray(d)) return { kind: 'array', text: `array[${d.length}]`, empty: d.length === 0 };
    if (typeof d === 'object') return { kind: 'object', text: `{${Object.keys(d).slice(0, 5).join(',')}}`, empty: Object.keys(d).length === 0 };
    return { kind: typeof d, text: String(d).slice(0, 40) };
}

(async () => {
    let failures = 0;
    for (const route of routes) {
        const t0 = Date.now();
        let line;
        let ok = true;
        try {
            const res = await fetch(base + route.path, { signal: AbortSignal.timeout(90000) });
            const ms = Date.now() - t0;
            const text = await res.text();
            let payload;
            try { payload = JSON.parse(text); } catch (_) { payload = null; }
            const shape = payload ? describe(payload) : { kind: 'non-json', text: text.slice(0, 60) };
            const statusOk = res.status === 200;
            const shapeOk = route.expect === 'any' || (shape.kind === route.expect && !shape.empty);
            ok = statusOk && shapeOk;
            line = `${ok ? 'PASS' : 'FAIL'} ${String(res.status).padEnd(3)} ${String(ms + 'ms').padStart(8)}  ${route.path.padEnd(62)} ${shape.text}${payload && payload.message ? '  msg=' + payload.message : ''}`;
        } catch (err) {
            ok = false;
            line = `FAIL ERR ${String(Date.now() - t0 + 'ms').padStart(8)}  ${route.path.padEnd(62)} ${err.message}`;
        }
        if (!ok && route.optional) line = line.replace(/^FAIL/, 'WARN');
        else if (!ok) failures++;
        console.log(line);
    }
    console.log(failures ? `\n${failures} route(s) failed against ${base}` : `\nall required routes passed against ${base}`);
    process.exit(failures ? 1 : 0);
})();
