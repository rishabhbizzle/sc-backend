'use strict';

// Pure helpers over the daily-history objects the cron writes:
//   { "DD-MM-YYYY": <number|null>, ... }
// Keys don't sort as strings and the history has gaps (a day the cron failed
// has no key) and nulls (kworb left the cell blank), so everything goes
// through series(), which parses, drops nulls and sorts by date.

const DAY_MS = 24 * 60 * 60 * 1000;
const HUNDRED_MILLION = 100_000_000;
const BILLION = 1_000_000_000;

const KEY_RE = /^(\d{2})-(\d{2})-(\d{4})$/;

// "DD-MM-YYYY" -> Date at UTC midnight, or null for anything malformed.
function parseKey(key) {
    const m = KEY_RE.exec(String(key));
    if (!m) return null;
    const [, dd, mm, yyyy] = m;
    const date = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
    // reject rollovers like 31-02-2026
    if (date.getUTCDate() !== +dd || date.getUTCMonth() !== +mm - 1) return null;
    return date;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatKey(date) {
    return `${pad2(date.getUTCDate())}-${pad2(date.getUTCMonth() + 1)}-${date.getUTCFullYear()}`;
}

// -> [{ key, date, value }] sorted ascending, numeric values only.
function series(obj) {
    if (!obj || typeof obj !== 'object') return [];
    const out = [];
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const date = parseKey(key);
        if (date) out.push({ key, date, value });
    }
    return out.sort((a, b) => a.date - b.date);
}

const latest = (s) => (s.length ? s[s.length - 1] : null);
const previous = (s) => (s.length > 1 ? s[s.length - 2] : null);

// Percentage change between two numbers, rounded to one decimal; null when
// either side is missing or the base is zero.
function pctChange(current, base) {
    if (typeof current !== 'number' || typeof base !== 'number' || base === 0) return null;
    return Math.round(((current - base) / base) * 1000) / 10;
}

// Average of the last `n` points that fall in the `windowDays` days ending at
// `asOf`. Needs at least `minPoints` points so a single odd day (or a new
// release's first day) doesn't drive an ETA. Returns null otherwise.
function avgDaily(s, asOf, { n = 7, windowDays = 10, minPoints = 3 } = {}) {
    if (!asOf || !s.length) return null;
    const from = asOf.getTime() - (windowDays - 1) * DAY_MS;
    const recent = s.filter((p) => p.date.getTime() >= from && p.date.getTime() <= asOf.getTime()).slice(-n);
    if (recent.length < minPoints) return null;
    return Math.round(recent.reduce((sum, p) => sum + p.value, 0) / recent.length);
}

// Songs and albums count every 100M (matching the artist Songs tab), artists
// every 1B. A milestone is "major" when it is a whole billion.
const stepFor = (type) => (type === 'artist' ? BILLION : HUNDRED_MILLION);

function nextMilestone(type, total) {
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null;
    const step = stepFor(type);
    const value = (Math.floor(total / step) + 1) * step;
    return { value, major: value % BILLION === 0 };
}

// Whole days until `total` reaches `milestone` at `avg` per day, at least 1.
function etaDays(total, avg, milestone) {
    if (typeof total !== 'number' || typeof milestone !== 'number' || !avg || avg <= 0) return null;
    if (total >= milestone) return 0;
    return Math.max(1, Math.ceil((milestone - total) / avg));
}

// Milestones passed going from prevTotal to total (exclusive of prevTotal,
// inclusive of total), e.g. 2.95B -> 3.05B for a song = [3B].
function crossed(type, prevTotal, total) {
    if (typeof prevTotal !== 'number' || typeof total !== 'number' || total <= prevTotal) return [];
    const step = stepFor(type);
    const out = [];
    for (let v = (Math.floor(prevTotal / step) + 1) * step; v <= total; v += step) out.push(v);
    return out;
}

// Cumulative total at the end of `date`, reconstructed backwards from the
// current total by subtracting every later day's streams. Returns null when
// the history doesn't reach back to `date` (or has a gap after it), because
// the answer would be a guess.
function totalAt(total, s, date) {
    if (typeof total !== 'number' || !s.length || !date) return null;
    const t = date.getTime();
    const first = s[0].date.getTime();
    if (t < first - DAY_MS) return null;
    const after = s.filter((p) => p.date.getTime() > t);
    // every day after `date` must be present, otherwise the subtraction is short
    if (after.length) {
        const span = Math.round((after[after.length - 1].date.getTime() - after[0].date.getTime()) / DAY_MS) + 1;
        if (span !== after.length) return null;
        if (Math.round((after[0].date.getTime() - t) / DAY_MS) !== 1) return null;
    }
    return total - after.reduce((sum, p) => sum + p.value, 0);
}

// Is the latest point an all-time high for this item? Only trusted once the
// history is long enough that "highest we've seen" means something.
function isRecord(s, { minHistory = 30 } = {}) {
    if (s.length < minHistory) return false;
    const last = s[s.length - 1].value;
    for (let i = 0; i < s.length - 1; i++) if (s[i].value >= last) return false;
    return last > 0;
}

const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / DAY_MS);

module.exports = {
    DAY_MS,
    HUNDRED_MILLION,
    BILLION,
    parseKey,
    formatKey,
    series,
    latest,
    previous,
    pctChange,
    avgDaily,
    stepFor,
    nextMilestone,
    etaDays,
    crossed,
    totalAt,
    isRecord,
    addDays,
    daysBetween,
};
