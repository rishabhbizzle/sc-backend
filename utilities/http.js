'use strict';

const axios = require('axios');
const { Semaphore, positiveIntEnv, nonNegativeIntEnv } = require('./semaphore');

// Plain HTTP fetcher for the static HTML sources (kworb, Wikipedia). These
// sites serve complete tables without JavaScript, so a ~1s GET replaces a
// full Chromium page load. Every call has a hard timeout, bounded retries,
// a concurrency cap, and identical in-flight URLs are coalesced so a burst of
// users asking for the same artist produces a single upstream request.

class UpstreamError extends Error {
    constructor(message, { url, status, code, cause } = {}) {
        super(message);
        this.name = 'UpstreamError';
        this.url = url;
        this.status = status;
        this.code = code;
        if (cause) this.cause = cause;
    }
}
class UpstreamNotFoundError extends UpstreamError {
    constructor(message, opts) { super(message, opts); this.name = 'UpstreamNotFoundError'; }
}
class UpstreamUnavailableError extends UpstreamError {
    constructor(message, opts) { super(message, opts); this.name = 'UpstreamUnavailableError'; }
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = positiveIntEnv(process.env.HTTP_TIMEOUT_MS, 20000);
const RETRIES = nonNegativeIntEnv(process.env.HTTP_RETRIES, 2);
const MAX_CONCURRENCY = positiveIntEnv(process.env.HTTP_MAX_CONCURRENCY, 6);
const QUEUE_TIMEOUT_MS = positiveIntEnv(process.env.HTTP_QUEUE_TIMEOUT_MS, 30000);
const MAX_BODY_BYTES = 15 * 1024 * 1024;

const semaphore = new Semaphore(MAX_CONCURRENCY, { name: 'http' });
const inflight = new Map();

// Per-host circuit breaker. After CIRCUIT_FAILURES consecutive upstream
// failures (timeouts, 5xx, network errors; a 404 means the site is up) the
// host is marked open for CIRCUIT_OPEN_MS: callers fail immediately instead
// of each burning a slot for timeout x retries. One probe is let through
// afterwards; a success closes the circuit, a failure re-opens it.
const CIRCUIT_FAILURES = positiveIntEnv(process.env.HTTP_CIRCUIT_FAILURES, 5);
const CIRCUIT_OPEN_MS = positiveIntEnv(process.env.HTTP_CIRCUIT_OPEN_MS, 30000);
const circuits = new Map();

function circuitFor(url) {
    const host = new URL(url).host;
    let c = circuits.get(host);
    if (!c) { c = { host, failures: 0, openedAt: 0, probing: false }; circuits.set(host, c); }
    return c;
}

function assertCircuitClosed(c) {
    if (!c.openedAt) return;
    const since = Date.now() - c.openedAt;
    if (since < CIRCUIT_OPEN_MS) {
        throw new UpstreamUnavailableError(`${c.host}: circuit open after ${c.failures} consecutive failures, retrying in ${Math.ceil((CIRCUIT_OPEN_MS - since) / 1000)}s`, { code: 'CIRCUIT_OPEN' });
    }
    if (c.probing) throw new UpstreamUnavailableError(`${c.host}: circuit half-open, a probe request is in flight`, { code: 'CIRCUIT_OPEN' });
    c.probing = true;
}

function recordOutcome(c, err) {
    if (!err || err instanceof UpstreamNotFoundError) {
        if (c.openedAt) console.warn(`[http] circuit CLOSED for ${c.host}`);
        c.failures = 0; c.openedAt = 0; c.probing = false;
        return;
    }
    c.probing = false;
    if (!(err instanceof UpstreamUnavailableError) || err.code === 'CIRCUIT_OPEN') return; // queue timeouts are not upstream failures
    c.failures++;
    if (c.failures >= CIRCUIT_FAILURES) {
        if (!c.openedAt) console.warn(`[http] circuit OPEN for ${c.host} after ${c.failures} consecutive failures`);
        c.openedAt = Date.now();
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'ERR_NETWORK', 'ERR_BAD_RESPONSE']);

function isRetryable(err) {
    if (err instanceof UpstreamNotFoundError) return false;
    if (err instanceof UpstreamUnavailableError) return err.status === 429 || (err.status >= 500 && err.status <= 599) || !err.status;
    return RETRYABLE_CODES.has(err.code) || /timeout/i.test(err.message || '');
}

function backoffMs(attempt) {
    // 1s, 2s, 4s ... plus a little jitter so retries from many callers spread out.
    return Math.min(8000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

async function fetchOnce(url, { userAgent, timeoutMs }) {
    let res;
    try {
        res = await axios.get(url, {
            timeout: timeoutMs,
            responseType: 'text',
            // Keep the body as-is; axios would otherwise try JSON.parse on 100KB+ of HTML.
            transformResponse: [(data) => data],
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            maxRedirects: 3,
            maxContentLength: MAX_BODY_BYTES,
            maxBodyLength: MAX_BODY_BYTES,
            validateStatus: () => true,
        });
    } catch (err) {
        throw new UpstreamUnavailableError(`${url}: ${err.message}`, { url, code: err.code, cause: err });
    }
    if (res.status === 404 || res.status === 410) {
        throw new UpstreamNotFoundError(`${url} returned HTTP ${res.status}`, { url, status: res.status });
    }
    if (res.status < 200 || res.status >= 300) {
        throw new UpstreamUnavailableError(`${url} returned HTTP ${res.status}`, { url, status: res.status });
    }
    if (typeof res.data !== 'string' || res.data.length === 0) {
        throw new UpstreamUnavailableError(`${url} returned an empty body`, { url, status: res.status });
    }
    return res.data;
}

async function fetchWithRetry(url, opts) {
    const retries = Number.isInteger(opts.retries) ? opts.retries : RETRIES;
    for (let attempt = 0; ; attempt++) {
        try {
            return await fetchOnce(url, opts);
        } catch (err) {
            if (attempt >= retries || !isRetryable(err)) throw err;
            const wait = backoffMs(attempt);
            console.warn(`[http] ${url} failed (${err.message}); retry ${attempt + 1}/${retries} in ${wait}ms`);
            await sleep(wait);
        }
    }
}

// Resolves to the HTML body as a string. Throws UpstreamNotFoundError for 404s
// (caller decides whether that is an empty result) and UpstreamUnavailableError
// for anything else after retries are exhausted.
function fetchHtml(url, { userAgent = DEFAULT_USER_AGENT, timeoutMs = TIMEOUT_MS, retries } = {}) {
    const existing = inflight.get(url);
    if (existing) return existing;
    const circuit = circuitFor(url);
    try { assertCircuitClosed(circuit); } catch (err) { return Promise.reject(err); }
    const promise = semaphore
        .run(() => fetchWithRetry(url, { userAgent, timeoutMs, retries }), QUEUE_TIMEOUT_MS)
        .then((html) => { recordOutcome(circuit, null); return html; }, (err) => { recordOutcome(circuit, err); throw err; })
        .finally(() => { if (inflight.get(url) === promise) inflight.delete(url); });
    inflight.set(url, promise);
    return promise;
}

function stats() {
    const now = Date.now();
    const hosts = Object.fromEntries([...circuits.values()].map((c) => [c.host, { consecutiveFailures: c.failures, open: !!c.openedAt && now - c.openedAt < CIRCUIT_OPEN_MS }]));
    return { ...semaphore.stats(), inflight: inflight.size, circuits: hosts };
}

module.exports = {
    fetchHtml,
    stats,
    UpstreamError,
    UpstreamNotFoundError,
    UpstreamUnavailableError,
    DEFAULT_USER_AGENT,
};
