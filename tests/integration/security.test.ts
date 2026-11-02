import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MAX_SESSION_AGE } from '../../src/middleware/auth.middleware.js';
import { createClient, errorOf, PASSWORD, register, startApp, type TestApp } from '../support/harness.js';

let app: TestApp;
before(async () => {
    app = await startApp();
});
beforeEach(() => app.reset());
after(() => app.close());

test('the health check answers and every response carries the security headers', async () => {
    const response = await createClient(app.url).get('/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    const csp = response.headers.get('content-security-policy') ?? '';
    for (const rule of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'"])
        assert.ok(csp.includes(rule), rule);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('x-powered-by'), null);
    const alias = await createClient(app.url).get('/healthz');
    assert.equal(alias.status, 200);
    assert.deepEqual(await alias.json(), { status: 'ok' });
});
test('pages are served with the same headers and are never cached', async () => {
    const response = await createClient(app.url).get('/index.html');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>Sign in · Mailbridge<\/title>/);
    assert.ok(response.headers.get('content-security-policy'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('state-changing requests must be same-site JSON', async () => {
    const client = createClient(app.url);
    const form = await client.request('POST', '/auth/login', 'email=a@example.com&password=x', {
        'Content-Type': 'application/x-www-form-urlencoded',
    });
    assert.equal(form.status, 415);
    const crossSite = await client.post('/auth/login', { email: 'a@example.com', password: 'x' }, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.status, 415);
    const foreignOrigin = await client.post('/auth/login', { email: 'a@example.com', password: 'x' }, { Origin: 'https://evil.example' });
    assert.equal(foreignOrigin.status, 415);
    const ownOrigin = await client.post('/auth/login', { email: 'a@example.com', password: 'x' }, { Origin: app.url });
    assert.equal(ownOrigin.status, 401);
});
test('malformed and oversized bodies are rejected without a server error', async () => {
    const client = createClient(app.url);
    assert.equal((await client.request('POST', '/auth/login', '{"email":')).status, 400);
    assert.equal((await client.post('/auth/login', { email: 'a@example.com', password: 'x'.repeat(70_000) })).status, 413);
});
test('unknown paths answer with a JSON not_found error instead of an HTML page', async () => {
    const client = createClient(app.url);
    for (const response of [await client.get('/no-such-page'), await client.post('/nothing-here', {})]) {
        assert.equal(response.status, 404);
        assert.match(response.headers.get('content-type') ?? '', /application\/json/);
        assert.deepEqual(await errorOf(response), { code: 'not_found', message: 'Not found.' });
    }
});
test('every data route requires a signed-in session', async () => {
    const client = createClient(app.url);
    for (const path of ['/auth/me', '/emails', '/accounts', '/users/me/avatar', '/emails/00000000-0000-4000-8000-000000000000']) {
        const response = await client.get(path);
        assert.equal(response.status, 401, path);
        assert.deepEqual(await response.json(), { error: { code: 'unauthenticated', message: 'Authentication required' } });
    }
    assert.equal((await client.patch('/users/me', { displayName: 'x' })).status, 401);
    assert.equal((await client.post('/emails/compose', {})).status, 401);
    assert.equal((await client.post('/accounts/00000000-0000-4000-8000-000000000000/sync')).status, 401);
});
test('signed-out visitors to the connect flow are sent to the sign-in page', async () => {
    const response = await createClient(app.url).get('/accounts/connect/gmail');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/index.html');
});
test('a session of a deactivated user stops working at once', async () => {
    const { client, user } = await register(app, 'gone@example.com');
    assert.equal((await client.get('/auth/me')).status, 200);
    await app.pool.query('UPDATE users SET is_active = FALSE WHERE user_id = $1', [user.userId]);
    assert.equal((await client.get('/auth/me')).status, 401);
});
test('malformed identifiers are rejected before reaching the database', async () => {
    const { client } = await register(app, 'ids@example.com');
    assert.equal((await client.get('/emails/not-a-uuid')).status, 400);
    assert.equal((await client.post('/accounts/not-a-uuid/sync')).status, 400);
    assert.equal((await client.get("/emails?account=1'%20OR%20'1'='1")).status, 400);
    assert.equal((await client.get('/emails?offset=10')).status, 400, 'unknown query parameters are refused');
    assert.equal((await client.get('/emails?sort=sideways')).status, 400);
});
test('profile names and photos are validated', async () => {
    const { client } = await register(app, 'profile@example.com');
    assert.equal((await client.patch('/users/me', { displayName: 'x'.repeat(81) })).status, 400);
    const renamed = await client.patch('/users/me', { displayName: '  Ada Lovelace ' });
    assert.equal(((await renamed.json()) as { user: { displayName: string } }).user.displayName, 'Ada Lovelace');
    assert.equal((await client.put('/users/me/avatar', { image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status, 400);
    assert.equal((await client.get('/users/me/avatar')).status, 404);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    assert.equal((await client.put('/users/me/avatar', { image: `data:image/png;base64,${png.toString('base64')}` })).status, 200);
    const photo = await client.get('/users/me/avatar');
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.equal(photo.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), png);
    assert.equal((await client.delete('/users/me/avatar')).status, 200);
    assert.equal((await client.get('/users/me/avatar')).status, 404);
});
test('a session ends a fixed time after sign-in, however active it has been', async () => {
    const { client } = await register(app, 'person@example.com');
    assert.equal((await client.get('/auth/me')).status, 200);
    await app.pool.query(`UPDATE sessions SET sess = jsonb_set(sess::jsonb, '{signedInAt}', to_jsonb($1::bigint))::json`, [
        Date.now() - MAX_SESSION_AGE - 60_000,
    ]);
    assert.equal((await client.get('/auth/me')).status, 401);
    assert.equal((await app.pool.query('SELECT 1 FROM sessions')).rowCount, 0, 'the expired session is removed');
});
test('a signed-in session cannot be used to guess the current password without limit', async () => {
    const { client } = await register(app, 'person@example.com');
    for (let attempt = 0; attempt < 10; attempt++) {
        assert.equal(
            (await client.post('/auth/password', { currentPassword: `guess-number-${attempt}`, newPassword: 'a-brand-new-password' }))
                .status,
            400,
        );
    }
    const blocked = await client.post('/auth/password', { currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '900');
    const { client: other } = await register(app, 'other@example.com');
    assert.equal(
        (await other.post('/auth/password', { currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' })).status,
        400,
        'limits are per person',
    );
});
test('sending is limited per person', async () => {
    const { client } = await register(app, 'person@example.com');
    const message = { accountId: randomUUID(), subject: 'Hi', body: 'Text', to: ['a@example.com'] };
    for (let attempt = 0; attempt < 60; attempt++)
        assert.equal((await client.post('/emails/compose', { ...message, requestId: randomUUID() })).status, 404);
    assert.equal((await client.post('/emails/compose', { ...message, requestId: randomUUID() })).status, 429);
    assert.equal(
        (await client.post(`/emails/${randomUUID()}/send`, { action: 'reply', requestId: randomUUID(), comment: 'Hi' })).status,
        429,
    );
});

test('every request is logged once with its request ID and path, never with secrets or query strings', async () => {
    // Health probes first: by the time the later requests' lines are checked, theirs have been written too.
    await createClient(app.url).get('/health');
    await createClient(app.url).get('/healthz');
    const { client } = await register(app, 'logged@example.com', 'a-secret-password-123');
    const response = await client.get('/emails?search=private-words');
    const requestId = response.headers.get('x-request-id');
    assert.match(requestId ?? '', /^[0-9a-f-]{36}$/);
    await client.post('/auth/login', { email: 'logged@example.com', password: 'wrong-password-456' });
    const line = app.logs.find(entry => (entry.req as { id?: string } | undefined)?.id === requestId);
    assert.ok(line, 'the request has a log line with the same ID as the response header');
    assert.deepEqual(line.req, { id: requestId, method: 'GET', path: '/emails' });
    assert.equal(line.res && (line.res as { statusCode: number }).statusCode, 200);
    assert.ok(line.userId, 'signed-in requests carry the user ID');
    assert.equal(line.msg, 'GET /emails 200');
    const everything = JSON.stringify(app.logs);
    for (const secret of ['private-words', 'a-secret-password-123', 'wrong-password-456', client.cookies.get('session') ?? 'no-cookie'])
        assert.ok(!everything.includes(secret), `the log never contains ${secret}`);
    assert.ok(
        !app.logs.some(entry => ['/health', '/healthz'].includes((entry.req as { path?: string } | undefined)?.path ?? '')),
        'health checks are not logged',
    );
});

test('static files are revalidated (cheap 304s) while API answers are never stored', async () => {
    const client = createClient(app.url);
    const first = await client.get('/css/tokens.css');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    // Like a browser revalidating; fetch() would otherwise add Cache-Control: no-cache, which forces a full reload.
    const again = await client.get('/css/tokens.css', { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' });
    assert.equal(again.status, 304, 'an unchanged file is not sent again');
    assert.equal((await client.get('/index.html')).headers.get('cache-control'), 'no-store', 'pages stay out of the back/forward cache');
    assert.equal((await client.get('/auth/config')).headers.get('cache-control'), 'no-store');
    assert.equal((await client.get('/.env')).status, 404, 'dotfiles are never served');
});
