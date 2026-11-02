import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/config/logger.js';

const capture = () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = createLogger({ level: 'info', destination: { write: line => void lines.push(JSON.parse(line)) } });
    return { lines, logger };
};

test('errors on ordinary log lines (start-up, shutdown) are logged without their message', () => {
    const { lines, logger } = capture();
    const error = Object.assign(new Error('connect failed for postgres://mailbridge:hunter2@10.0.4.10/mailbridge'), {
        code: 'ECONNREFUSED',
    });
    logger.fatal({ err: error }, 'database unavailable');
    const line = lines[0];
    assert.ok(line);
    assert.deepEqual(Object.keys(line.err as object).sort(), ['code', 'stack', 'type']);
    assert.equal((line.err as { type: string }).type, 'Error');
    // `*.code` is on the redaction list (OAuth codes), which also masks error codes.
    assert.equal((line.err as { code: string }).code, '[redacted]');
    assert.ok(!JSON.stringify(line).includes('hunter2'), 'the message never reaches the log');
    assert.equal(line.msg, 'database unavailable');
});
