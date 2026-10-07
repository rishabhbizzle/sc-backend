'use strict';
// Exercises the pool with a fake launcher: no Chromium is started.
process.env.BROWSER_MAX_CONCURRENCY = '1';
process.env.BROWSER_PAGE_OPEN_TIMEOUT_MS = '150';
process.env.BROWSER_JOB_TIMEOUT_MS = '200';
process.env.BROWSER_QUEUE_TIMEOUT_MS = '150';
process.env.PRODUCTION = 'true';
process.env.PUPPETEER_EXECUTABLE_PATH = '/nonexistent/chrome';
const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../utilities/browser');
const { sleep } = require('./helpers');

let launches;
function fakeBrowser({ hangNewPage = false, hangClose = false } = {}) {
    const browser = {
        connected: true, closed: false, killed: false, pagesOpened: 0,
        on() {},
        async newPage() {
            if (hangNewPage) return new Promise(() => {});
            browser.pagesOpened++;
            const page = { closed: false, setDefaultNavigationTimeout() {}, setDefaultTimeout() {}, async close() { if (hangClose) return new Promise(() => {}); page.closed = true; } };
            return page;
        },
        async close() { browser.closed = true; browser.connected = false; },
        process() { return { exitCode: null, killed: false, kill() { browser.killed = true; } }; },
    };
    return browser;
}
function useLauncher(opts = {}) {
    launches = [];
    pool._resetForTests();
    pool._setLauncher(async () => { const b = fakeBrowser(opts); launches.push(b); return b; });
}

test('reuses one browser across sequential jobs', async () => {
    useLauncher();
    for (let i = 0; i < 4; i++) assert.equal(await pool.withPage(async () => 'ok'), 'ok');
    assert.equal(launches.length, 1);
    assert.equal(launches[0].pagesOpened, 4);
    assert.equal(pool.stats().active, 0);
});

test('a browser that never opens a page is killed and relaunched on the next call', async () => {
    useLauncher({ hangNewPage: true });
    const t0 = Date.now();
    await assert.rejects(pool.withPage(async () => 'never'), pool.BrowserTimeoutError);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(launches[0].closed, true, 'hung browser was closed');
    assert.equal(pool.stats().active, 0, 'slot released');
    pool._setLauncher(async () => { const b = fakeBrowser(); launches.push(b); return b; });
    assert.equal(await pool.withPage(async () => 'recovered'), 'recovered');
    assert.equal(launches.length, 2);
});

test('a job that overruns its deadline fails fast and restarts the browser', async () => {
    useLauncher();
    await assert.rejects(pool.withPage(() => new Promise(() => {})), /scrape job timed out/);
    assert.equal(launches[0].closed, true);
    assert.equal(await pool.withPage(async () => 'ok'), 'ok');
    assert.equal(launches.length, 2);
});

test('callers do not queue forever behind a busy pool', async () => {
    useLauncher();
    let finish;
    const held = pool.withPage(() => new Promise((resolve) => { finish = resolve; }));
    await sleep(20);
    await assert.rejects(pool.withPage(async () => 'x'), pool.SemaphoreTimeoutError);
    finish('done');
    assert.equal(await held, 'done');
    assert.equal(await pool.withPage(async () => 'after'), 'after');
    assert.equal(launches.length, 1, 'a healthy browser is kept');
});

test('a page that cannot be closed marks the browser unhealthy', async () => {
    useLauncher({ hangClose: true });
    assert.equal(await pool.withPage(async () => 'ok'), 'ok');
    assert.equal(launches[0].closed, true, 'browser restarted after page.close hung');
    assert.equal(pool.stats().active, 0);
});

test('three consecutive ordinary failures also recycle the browser', async () => {
    useLauncher();
    for (let i = 0; i < 3; i++) await assert.rejects(pool.withPage(async () => { throw new Error('scrape failed'); }), /scrape failed/);
    assert.equal(launches[0].closed, true);
    assert.equal(await pool.withPage(async () => 'ok'), 'ok');
    assert.equal(launches.length, 2);
});

test('a launch that rejects leaves no stale handle behind', async () => {
    launches = [];
    pool._resetForTests();
    let calls = 0;
    pool._setLauncher(async () => { calls++; if (calls === 1) throw new Error('chrome missing'); const b = fakeBrowser(); launches.push(b); return b; });
    await assert.rejects(pool.withPage(async () => 'x'), /chrome missing/);
    assert.equal(await pool.withPage(async () => 'ok'), 'ok');
    assert.equal(calls, 2);
});
