'use strict';

const puppeteer = require('puppeteer');
const { Semaphore, SemaphoreTimeoutError, positiveIntEnv } = require('./semaphore');

// One shared Chromium instance, reused across requests, with a small
// concurrency cap. Since the kworb/Wikipedia scrapers moved to plain HTTP the
// only remaining user is the Chartmetric social scrape, but the pool is kept
// safe for anything else that needs a real browser:
//   - a caller waits at most BROWSER_QUEUE_TIMEOUT_MS for a slot, then fails
//     fast instead of queueing forever behind slow jobs;
//   - every job has an overall deadline, and page creation / page close have
//     their own short timeouts;
//   - if Chromium stops responding (job or close timeout, protocol error, or
//     several consecutive failures) it is killed and relaunched on the next
//     call. The old pool only relaunched after a clean disconnect, so a hung
//     but still "connected" browser wedged every slot for good.

class BrowserTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BrowserTimeoutError';
        this.code = 'BROWSER_TIMEOUT';
    }
}

const MAX = positiveIntEnv(process.env.BROWSER_MAX_CONCURRENCY, 3); // 3 fits a 4GB/2vCPU droplet
const NAV_TIMEOUT_MS = positiveIntEnv(process.env.BROWSER_NAV_TIMEOUT_MS, 30000);
const QUEUE_TIMEOUT_MS = positiveIntEnv(process.env.BROWSER_QUEUE_TIMEOUT_MS, 20000);
const JOB_TIMEOUT_MS = positiveIntEnv(process.env.BROWSER_JOB_TIMEOUT_MS, 60000);
const PROTOCOL_TIMEOUT_MS = positiveIntEnv(process.env.BROWSER_PROTOCOL_TIMEOUT_MS, 45000);
const LAUNCH_TIMEOUT_MS = positiveIntEnv(process.env.BROWSER_LAUNCH_TIMEOUT_MS, 30000);
const PAGE_OPEN_TIMEOUT_MS = positiveIntEnv(process.env.BROWSER_PAGE_OPEN_TIMEOUT_MS, 15000);
const PAGE_CLOSE_TIMEOUT_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;

// NOTE: keep the executablePath expression exactly as it was in the per-request
// launches so production Chromium resolution is unchanged.
const launchOptions = () => ({
    args: [
        '--disable-setuid-sandbox',
        '--no-sandbox',
        '--disable-dev-shm-usage',
    ],
    executablePath: process.env.PRODUCTION == 'true'
        ? process.env.PUPPETEER_EXECUTABLE_PATH
        : puppeteer.executablePath(),
    timeout: LAUNCH_TIMEOUT_MS,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
});

// Test seam: lets the unit tests swap in a fake launcher.
let launcher = (opts) => puppeteer.launch(opts);

const semaphore = new Semaphore(MAX, { name: 'browser' });
let browserPromise = null;
let consecutiveFailures = 0;
let lastError = null;

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BrowserTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isConnected(browser) {
    if (!browser) return false;
    if (typeof browser.connected === 'boolean') return browser.connected;
    if (typeof browser.isConnected === 'function') return browser.isConnected();
    return false;
}

async function getBrowser() {
    if (browserPromise) {
        const existing = await browserPromise.catch(() => null);
        if (isConnected(existing)) return existing;
        // crashed / disconnected -> drop the handle and relaunch below
        browserPromise = null;
    }
    const launching = launcher(launchOptions());
    browserPromise = launching;
    let browser;
    try {
        browser = await launching;
    } catch (err) {
        if (browserPromise === launching) browserPromise = null;
        throw err;
    }
    // Only clear the handle if it still points at THIS browser, so a stale
    // browser's disconnect can't null out a newer launch.
    browser.on('disconnected', () => { if (browserPromise === launching) browserPromise = null; });
    return browser;
}

// Force the shared browser down. Used on graceful shutdown and whenever a job
// suggests Chromium is no longer healthy; the next withPage() relaunches it.
async function killBrowser(reason) {
    const current = browserPromise;
    browserPromise = null;
    if (!current) return;
    let browser;
    try {
        browser = await withTimeout(current, PAGE_CLOSE_TIMEOUT_MS, 'browser handle');
    } catch (_) {
        return; // launch never settled or failed; nothing to kill
    }
    if (reason) console.warn(`[browser] restarting Chromium: ${reason}`);
    try { await withTimeout(browser.close(), PAGE_CLOSE_TIMEOUT_MS, 'browser.close'); } catch (_) { /* fall through to SIGKILL */ }
    try {
        const proc = typeof browser.process === 'function' ? browser.process() : null;
        if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
    } catch (_) { /* ignore */ }
}

function looksLikeBrowserFailure(err) {
    if (err instanceof BrowserTimeoutError) return true;
    const msg = String(err && err.message || '');
    return /Protocol error|Target closed|Session closed|Connection closed|Navigating frame was detached|browser has disconnected|Runtime\.callFunctionOn timed out|ProtocolError/i.test(msg)
        || (err && err.name === 'ProtocolError');
}

// Runs `fn(page)` on a fresh page from the shared browser, bounded by the
// concurrency cap and an overall deadline, and ALWAYS releases the slot.
async function withPage(fn, { jobTimeoutMs = JOB_TIMEOUT_MS, queueTimeoutMs = QUEUE_TIMEOUT_MS } = {}) {
    await semaphore.acquire(queueTimeoutMs);
    let page;
    let unhealthy = false;
    try {
        const browser = await withTimeout(getBrowser(), LAUNCH_TIMEOUT_MS + 5000, 'browser launch');
        page = await withTimeout(browser.newPage(), PAGE_OPEN_TIMEOUT_MS, 'browser.newPage');
        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
        page.setDefaultTimeout(NAV_TIMEOUT_MS);
        const result = await withTimeout(fn(page), jobTimeoutMs, 'scrape job');
        consecutiveFailures = 0;
        return result;
    } catch (err) {
        consecutiveFailures++;
        lastError = { at: new Date().toISOString(), message: err && err.message };
        if (looksLikeBrowserFailure(err) || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) unhealthy = true;
        throw err;
    } finally {
        if (page) {
            try { await withTimeout(page.close(), PAGE_CLOSE_TIMEOUT_MS, 'page.close'); }
            catch (_) { unhealthy = true; }
        }
        if (unhealthy) {
            const why = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
                ? `${consecutiveFailures} consecutive failures`
                : 'job or page timeout';
            consecutiveFailures = 0;
            await killBrowser(why);
        }
        semaphore.release();
    }
}

// Closes the shared browser (used on graceful shutdown so Chromium children
// don't orphan when the process restarts).
async function closeBrowser() {
    await killBrowser();
}

function stats() {
    return { ...semaphore.stats(), browserLaunched: browserPromise !== null, consecutiveFailures, lastError };
}

module.exports = {
    withPage,
    closeBrowser,
    stats,
    BrowserTimeoutError,
    SemaphoreTimeoutError,
    _setLauncher(fn) { launcher = fn; },
    _resetForTests() { browserPromise = null; consecutiveFailures = 0; lastError = null; },
};
