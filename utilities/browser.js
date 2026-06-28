const puppeteer = require('puppeteer');

// One shared Chromium instance is reused across all requests instead of
// launching a full browser per request (which exhausted RAM under traffic
// spikes and left orphaned Chromium processes that never freed memory).
// A small FIFO semaphore caps how many pages run at once, so a spike queues
// instead of OOM-killing the box.
// Parse a positive-integer env var, falling back to a default for unset /
// non-numeric / zero / negative values so a fat-fingered env can never wedge
// the semaphore (MAX=0/NaN would otherwise deadlock every request).
function positiveIntEnv(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

const MAX = positiveIntEnv(process.env.BROWSER_MAX_CONCURRENCY, 3); // 3 fits a 4GB/2vCPU droplet
const NAV_TIMEOUT_MS = positiveIntEnv(process.env.BROWSER_NAV_TIMEOUT_MS, 30000);

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
});

let browserPromise = null;

async function getBrowser() {
    if (browserPromise) {
        const b = await browserPromise.catch(() => null);
        if (b && b.connected) return b;
        // crashed / disconnected -> drop the handle and relaunch below
        browserPromise = null;
    }
    browserPromise = puppeteer.launch(launchOptions());
    const launching = browserPromise;
    const b = await browserPromise;
    // Only clear the handle if it still points at THIS browser, so a stale
    // browser's disconnect can't null out a newer launch (which would cause a
    // second browser to spawn and orphan one).
    b.on('disconnected', () => { if (browserPromise === launching) browserPromise = null; });
    return b;
}

// --- dependency-free FIFO semaphore ---
let active = 0;
const waiters = [];
function acquire() {
    if (active < MAX) {
        active++;
        return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
}
function release() {
    active--;
    const next = waiters.shift();
    if (next) {
        active++;
        next();
    }
}

// Runs `fn(page)` on a fresh page from the shared browser, bounded by the
// concurrency cap, and ALWAYS closes the page in finally.
async function withPage(fn) {
    await acquire();
    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
        page.setDefaultTimeout(NAV_TIMEOUT_MS);
        return await fn(page);
    } finally {
        if (page) {
            try { await page.close(); } catch (_) { /* ignore */ }
        }
        release();
    }
}

// Closes the shared browser (used on graceful shutdown so Chromium children
// don't orphan when the process restarts).
async function closeBrowser() {
    const p = browserPromise;
    browserPromise = null;
    if (p) {
        try {
            const b = await p;
            await b.close();
        } catch (_) { /* ignore */ }
    }
}

module.exports = { withPage, closeBrowser };
