import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/config/env.js';

const base = {
    NODE_ENV: 'development',
    SESSION_SECRET: 'dev-secret',
    POSTGRES_HOST: 'localhost',
    POSTGRES_PORT: '5432',
    POSTGRES_DB: 'mailbridge',
    POSTGRES_USER: 'mailbridge',
    POSTGRES_PASSWORD: 'password',
};
const production = {
    ...base,
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://mail.example.com',
    SESSION_SECRET: 's'.repeat(32),
    TOKEN_ENCRYPTION_KEY: 'k'.repeat(32),
    TRUST_PROXY: '1',
};
const refuses = (source: Record<string, string>, name: string) =>
    assert.throws(
        () => loadEnv(source),
        (error: Error) => error.message.includes(`  ${name}:`),
        name,
    );

test('development defaults are filled in', () => {
    const env = loadEnv(base);
    assert.equal(env.PORT, 3000);
    assert.equal(env.PUBLIC_ORIGIN, 'http://localhost:3000');
    assert.equal(env.EXPECTED_ORIGIN, null);
    assert.equal(env.TOKEN_ENCRYPTION_KEY, 'dev-secret', 'falls back to the session secret outside production');
    assert.equal(env.ALLOW_REGISTRATION, true);
    assert.equal(env.TRUST_PROXY, 0);
    assert.equal(env.POSTGRES_SSL, false);
    assert.deepEqual([env.MICROSOFT, env.GOOGLE, env.SMTP], [undefined, undefined, undefined]);
    assert.deepEqual(loadEnv({ ...base, GMAIL_ALLOWED_EMAILS: ' A@x.com, ,b@y.com ' }).GMAIL_ALLOWED_EMAILS, ['a@x.com', 'b@y.com']);
});

test('a valid production configuration loads', () => {
    const env = loadEnv({ ...production, TRUST_PROXY: '1', SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'Mailbridge <no-reply@example.com>' });
    assert.equal(env.EXPECTED_ORIGIN, 'https://mail.example.com');
    assert.equal(env.TRUST_PROXY, 1);
    assert.deepEqual(env.SMTP, {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: undefined,
        password: undefined,
        from: 'Mailbridge <no-reply@example.com>',
    });
});

test('production refuses weak, reused or placeholder secrets and a non-HTTPS origin', () => {
    refuses({ ...production, SESSION_SECRET: 'short' }, 'SESSION_SECRET');
    refuses({ ...production, TOKEN_ENCRYPTION_KEY: '' }, 'TOKEN_ENCRYPTION_KEY');
    refuses({ ...production, TOKEN_ENCRYPTION_KEY: `REPLACE_${'x'.repeat(32)}` }, 'TOKEN_ENCRYPTION_KEY');
    refuses({ ...production, TOKEN_ENCRYPTION_KEY: production.SESSION_SECRET }, 'TOKEN_ENCRYPTION_KEY');
    refuses({ ...production, PUBLIC_ORIGIN: 'http://mail.example.com' }, 'PUBLIC_ORIGIN');
    refuses({ ...production, PUBLIC_ORIGIN: '' }, 'PUBLIC_ORIGIN');
    refuses({ ...production, PUBLIC_ORIGIN: 'https://mail.example.com/' }, 'PUBLIC_ORIGIN');
});

test('production refuses to run without trusting the TLS-terminating proxy', () => {
    refuses({ ...production, TRUST_PROXY: '0' }, 'TRUST_PROXY');
    refuses({ ...production, TRUST_PROXY: '' }, 'TRUST_PROXY');
    assert.equal(loadEnv({ ...base, TRUST_PROXY: '0' }).TRUST_PROXY, 0, 'development may run without a proxy');
});

test('PostgreSQL TLS takes an optional PEM CA, in one line or several', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    assert.deepEqual(loadEnv({ ...base, POSTGRES_SSL: 'true' }).POSTGRES_SSL, { ca: undefined });
    assert.deepEqual(loadEnv({ ...base, POSTGRES_SSL: 'true', POSTGRES_SSL_CA: pem }).POSTGRES_SSL, { ca: pem });
    const oneLine = pem.replaceAll('\n', '\\n');
    assert.deepEqual(loadEnv({ ...base, POSTGRES_SSL: 'true', POSTGRES_SSL_CA: oneLine }).POSTGRES_SSL, { ca: pem });
    refuses({ ...base, POSTGRES_SSL: 'require' }, 'POSTGRES_SSL');
    refuses({ ...base, POSTGRES_SSL_CA: pem }, 'POSTGRES_SSL_CA');
    refuses({ ...base, POSTGRES_SSL: 'true', POSTGRES_SSL_CA: 'not a certificate' }, 'POSTGRES_SSL_CA');
});

test('inconsistent or malformed settings are refused by name, without echoing values', () => {
    refuses({ ...base, NODE_ENV: 'staging' }, 'NODE_ENV');
    refuses({ ...base, POSTGRES_PORT: '70000' }, 'POSTGRES_PORT');
    refuses({ ...base, POSTGRES_PASSWORD: '' }, 'POSTGRES_PASSWORD');
    refuses({ ...base, GOOGLE_CLIENT_ID: 'id-only' }, 'GOOGLE_CLIENT_ID');
    refuses({ ...base, SMTP_HOST: 'smtp.example.com' }, 'SMTP_FROM');
    refuses({ ...base, TRUST_PROXY: 'yes' }, 'TRUST_PROXY');
    assert.throws(
        () => loadEnv({ ...production, SESSION_SECRET: 'hunter2-secret-value' }),
        (error: Error) => !error.message.includes('hunter2'),
    );
});
