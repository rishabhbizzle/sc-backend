'use strict';

// Tiny FIFO semaphore with a bounded wait. Callers that cannot get a slot
// within `timeoutMs` are rejected instead of queueing forever, so a burst of
// slow jobs can never turn into an unbounded backlog that starves everything
// behind it (which is exactly how the scrape routes and the cron wedged).
class SemaphoreTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SemaphoreTimeoutError';
        this.code = 'SEMAPHORE_TIMEOUT';
    }
}

class Semaphore {
    constructor(max, { name = 'semaphore' } = {}) {
        if (!Number.isInteger(max) || max < 1) throw new Error(`Semaphore max must be a positive integer, got ${max}`);
        this.max = max;
        this.name = name;
        this.active = 0;
        this.waiters = [];
    }

    acquire(timeoutMs) {
        if (this.active < this.max) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const waiter = { resolve, timer: null };
            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                waiter.timer = setTimeout(() => {
                    const i = this.waiters.indexOf(waiter);
                    if (i !== -1) this.waiters.splice(i, 1);
                    reject(new SemaphoreTimeoutError(
                        `${this.name}: no free slot after ${timeoutMs}ms (${this.active}/${this.max} busy, ${this.waiters.length} queued)`
                    ));
                }, timeoutMs);
            }
            this.waiters.push(waiter);
        });
    }

    release() {
        const next = this.waiters.shift();
        if (next) {
            // Hand the slot straight to the next waiter; `active` is unchanged.
            if (next.timer) clearTimeout(next.timer);
            next.resolve();
        } else {
            this.active = Math.max(0, this.active - 1);
        }
    }

    async run(fn, timeoutMs) {
        await this.acquire(timeoutMs);
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    stats() {
        return { max: this.max, active: this.active, queued: this.waiters.length };
    }
}

// Parse a positive-integer env var, falling back for unset / non-numeric /
// non-positive values so a typo in the env can never wedge a limiter.
function positiveIntEnv(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeIntEnv(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

module.exports = { Semaphore, SemaphoreTimeoutError, positiveIntEnv, nonNegativeIntEnv };
