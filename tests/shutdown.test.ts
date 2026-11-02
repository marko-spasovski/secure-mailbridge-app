import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { shutdown } from '../src/http/shutdown.js';

const silent = { info: () => {}, warn: () => {} };
const fakePool = () => {
    const pool = {
        ended: false,
        async end() {
            pool.ended = true;
        },
    };
    return pool;
};

async function listen(handler: Parameters<typeof createServer>[1]) {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

test('shutdown waits for a request in flight, then ends the pool', async () => {
    const pool = fakePool();
    const { server, url } = await listen((_req, res) => {
        setTimeout(() => res.end('done'), 100);
    });
    const response = fetch(url).then(r => r.text());
    await new Promise(resolve => setTimeout(resolve, 20));
    await shutdown(server, pool, silent, 5_000);
    assert.equal(await response, 'done', 'the request in flight finished normally');
    assert.equal(pool.ended, true);
});

test('shutdown cuts off a request that outlives the deadline instead of hanging', async () => {
    const pool = fakePool();
    const warnings: unknown[] = [];
    const { server, url } = await listen(() => {
        // Never answers, like a provider call stuck in a retry backoff.
    });
    const response = fetch(url).then(
        () => 'answered',
        () => 'cut off',
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    let timer: NodeJS.Timeout | undefined;
    const tooLate = new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('still waiting'), 2_000);
    });
    try {
        const outcome = await Promise.race([
            shutdown(server, pool, { ...silent, warn: (entry: unknown) => warnings.push(entry) }, 100).then(() => 'finished'),
            tooLate,
        ]);
        assert.equal(outcome, 'finished', 'returned soon after the deadline');
        assert.equal(await response, 'cut off');
        assert.equal(pool.ended, true);
        assert.equal(warnings.length, 1);
    } finally {
        clearTimeout(timer);
        // Lets the test process exit even when shutdown() is broken.
        server.closeAllConnections();
    }
});
