'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Semaphore, SemaphoreTimeoutError, positiveIntEnv, nonNegativeIntEnv } = require('../utilities/semaphore');
const { sleep } = require('./helpers');

test('caps concurrency and hands slots over in FIFO order', async () => {
    const sem = new Semaphore(2, { name: 't' });
    const order = [];
    const job = (id, ms) => sem.run(async () => { order.push(`start ${id}`); await sleep(ms); order.push(`end ${id}`); });
    await Promise.all([job('a', 30), job('b', 30), job('c', 5), job('d', 5)]);
    assert.deepEqual(order.slice(0, 2), ['start a', 'start b']);
    assert.ok(order.indexOf('start c') > order.indexOf('end a') || order.indexOf('start c') > order.indexOf('end b'));
    assert.ok(order.indexOf('start c') < order.indexOf('start d'));
    assert.deepEqual(sem.stats(), { max: 2, active: 0, queued: 0 });
});

test('a waiter that outlives its timeout is rejected and removed from the queue', async () => {
    const sem = new Semaphore(1, { name: 't' });
    await sem.acquire();
    await assert.rejects(sem.acquire(50), SemaphoreTimeoutError);
    assert.deepEqual(sem.stats(), { max: 1, active: 1, queued: 0 });
    sem.release();
    assert.deepEqual(sem.stats(), { max: 1, active: 0, queued: 0 });
    await sem.acquire(50); // still usable afterwards
    sem.release();
});

test('release never goes negative and run() releases on throw', async () => {
    const sem = new Semaphore(1);
    await assert.rejects(sem.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(sem.stats().active, 0);
    sem.release();
    assert.equal(sem.stats().active, 0);
});

test('env parsing helpers fall back on junk', () => {
    assert.equal(positiveIntEnv('7', 3), 7);
    assert.equal(positiveIntEnv('0', 3), 3);
    assert.equal(positiveIntEnv('abc', 3), 3);
    assert.equal(positiveIntEnv(undefined, 3), 3);
    assert.equal(nonNegativeIntEnv('0', 3), 0);
    assert.equal(nonNegativeIntEnv('-1', 3), 3);
});
