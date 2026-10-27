'use strict';
process.env.HTTP_CIRCUIT_FAILURES = '4'; // earlier tests in this file produce 3 failures before a success resets the count
process.env.HTTP_CIRCUIT_OPEN_MS = '600';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchHtml, UpstreamNotFoundError, UpstreamUnavailableError, stats } = require('../utilities/http');
const { sleep } = require('./helpers');

let server;
let base;
const hits = {};
test.before(async () => {
    server = http.createServer(async (req, res) => {
        hits[req.url] = (hits[req.url] || 0) + 1;
        if (req.url === '/ok') return res.end('<html><table><tr><td>ok</td></tr></table></html>');
        if (req.url === '/flaky') { if (hits[req.url] <= 2) { res.statusCode = 503; return res.end('busy'); } return res.end('<html>recovered</html>'); }
        if (req.url === '/missing') { res.statusCode = 404; return res.end('nope'); }
        if (req.url === '/teapot') { res.statusCode = 418; return res.end('no'); }
        if (req.url === '/slow') { await sleep(1500); return res.end('late'); }
        if (req.url === '/dedupe') { await sleep(150); return res.end('<html>shared</html>'); }
        if (req.url === '/empty') return res.end('');
        res.statusCode = 500; res.end('err');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('returns the body for a 200', async () => {
    const html = await fetchHtml(`${base}/ok`);
    assert.match(html, /<table>/);
});

test('retries 5xx with backoff and succeeds', async () => {
    const html = await fetchHtml(`${base}/flaky`, { retries: 2 });
    assert.equal(html, '<html>recovered</html>');
    assert.equal(hits['/flaky'], 3);
});

test('404 is UpstreamNotFoundError and is not retried', async () => {
    await assert.rejects(fetchHtml(`${base}/missing`, { retries: 2 }), UpstreamNotFoundError);
    assert.equal(hits['/missing'], 1);
});

test('non-retryable 4xx is UpstreamUnavailableError with the status, not retried', async () => {
    await assert.rejects(fetchHtml(`${base}/teapot`, { retries: 2 }), (err) => err instanceof UpstreamUnavailableError && err.status === 418);
    assert.equal(hits['/teapot'], 1);
});

test('a slow upstream hits the timeout instead of hanging', async () => {
    const t0 = Date.now();
    await assert.rejects(fetchHtml(`${base}/slow`, { timeoutMs: 200, retries: 0 }), (err) => err instanceof UpstreamUnavailableError && /timeout/i.test(err.message));
    assert.ok(Date.now() - t0 < 1200, 'did not wait for the slow response');
});

test('an empty body is treated as unavailable', async () => {
    await assert.rejects(fetchHtml(`${base}/empty`, { retries: 0 }), UpstreamUnavailableError);
});

test('identical in-flight URLs share one upstream request', async () => {
    const [a, b, c] = await Promise.all([fetchHtml(`${base}/dedupe`), fetchHtml(`${base}/dedupe`), fetchHtml(`${base}/dedupe`)]);
    assert.equal(a, b); assert.equal(b, c);
    assert.equal(hits['/dedupe'], 1);
    assert.equal(stats().inflight, 0, 'in-flight entry is cleared after settling');
    await fetchHtml(`${base}/dedupe`);
    assert.equal(hits['/dedupe'], 2, 'a later call fetches again');
});

test('circuit breaker: repeated upstream failures fail fast, then a probe closes it again', async () => {
    const host = `http://localhost:${server.address().port}`; // distinct host string from 127.0.0.1 => its own circuit
    for (let i = 0; i < 4; i++) await assert.rejects(fetchHtml(`${host}/boom`, { retries: 0 }), UpstreamUnavailableError);
    assert.equal(hits['/boom'], 4);
    await assert.rejects(fetchHtml(`${host}/boom`, { retries: 0 }), (err) => err.code === 'CIRCUIT_OPEN' && /circuit open/.test(err.message));
    assert.equal(hits['/boom'], 4, 'open circuit makes no upstream request');
    assert.equal(stats().circuits[`localhost:${server.address().port}`].open, true);
    await sleep(700);
    assert.match(await fetchHtml(`${host}/ok`), /<table>/, 'half-open probe goes through');
    assert.equal(stats().circuits[`localhost:${server.address().port}`].open, false);
    assert.equal(stats().circuits[`localhost:${server.address().port}`].consecutiveFailures, 0);
});
