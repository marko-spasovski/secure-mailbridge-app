import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionOptions, databaseTls } from '../src/config/database.js';

const config = {
    POSTGRES_HOST: '10.0.4.10',
    POSTGRES_PORT: 5432,
    POSTGRES_DB: 'mailbridge',
    POSTGRES_USER: 'mailbridge',
    POSTGRES_PASSWORD: 'password',
    POSTGRES_SSL: false as const,
};
const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

test('PostgreSQL TLS is off unless configured', () => {
    assert.equal(databaseTls(false), false);
    assert.equal(connectionOptions(config).ssl, false);
});

test('PostgreSQL TLS always verifies the certificate, with or without a private CA', () => {
    assert.deepEqual(databaseTls({ ca: undefined }), { rejectUnauthorized: true });
    assert.deepEqual(databaseTls({ ca: CA }), { rejectUnauthorized: true, ca: CA });
    const options = connectionOptions({ ...config, POSTGRES_SSL: { ca: CA } });
    assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca: CA });
    // No custom checkServerIdentity: Node's default checks that the certificate names POSTGRES_HOST.
    assert.ok(typeof options.ssl === 'object' && !('checkServerIdentity' in options.ssl));
});
