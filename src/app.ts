import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Pool } from 'pg';
import type { Env } from './config/env.js';
import { createRequestLogger, type Logger } from './config/logger.js';
import { createMailRegistry } from './integrations/mail/registry.js';
import { createMailer } from './integrations/mailer.js';
import { createAuthMiddleware } from './middleware/auth.middleware.js';
import { errorMiddleware, notFoundMiddleware } from './middleware/error.middleware.js';
import { createRequireSameSiteJson } from './middleware/json.middleware.js';
import { createSecurityHeaders, throttle } from './middleware/security.middleware.js';
import { createSessionMiddleware, sessionCookie } from './middleware/session.middleware.js';
import { createAccountsRepository } from './modules/accounts/accounts.repository.js';
import { createAccountsRouter } from './modules/accounts/accounts.routes.js';
import { createAudit } from './modules/audit/audit.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createEmailRepository } from './modules/emails/emails.repository.js';
import { createEmailRouter } from './modules/emails/emails.routes.js';
import { createEmailService } from './modules/emails/emails.service.js';
import { createUserRepository } from './modules/users/users.repository.js';
import { createUserRouter } from './modules/users/users.routes.js';
import { createUserService } from './modules/users/users.service.js';
import { createTokenVault } from './security/token-vault.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

export interface AppDependencies {
    pool: Pool;
    env: Env;
    logger: Logger;
}

// Builds the whole application from its dependencies. Only server.ts and the tests call this.
export function createApp({ pool, env, logger }: AppDependencies) {
    const app = express();

    app.disable('x-powered-by');
    // First, so every later line, refusal and error carries the request ID.
    app.use(createRequestLogger(logger));
    // Only this many proxies in front of the app may tell it the client's address (X-Forwarded-For).
    if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
    app.use(createSecurityHeaders({ production: env.NODE_ENV === 'production' }));
    // Liveness: answers as long as the process serves HTTP. Registered before the session middleware and anything
    // else that could reach the database, so a flood of probes costs no connection from the pool. Readiness (the
    // database answers too) is GET /health.
    app.get('/healthz', (_req, res) => {
        res.json({ status: 'ok' });
    });
    const audit = createAudit(pool);
    // Requests turned away as cross-site or throttled are kept for review.
    app.use((req, res, next) => {
        res.once('finish', () => {
            if (res.statusCode !== 415 && !res.locals.throttled) return;
            void audit.record(req, 'request-refused', 'denied', {
                email: typeof req.body?.email === 'string' ? req.body.email : undefined,
                detail: { status: res.statusCode, method: req.method, path: req.path },
            });
        });
        next();
    });
    app.use(createRequireSameSiteJson(env.EXPECTED_ORIGIN));
    // Profile photos arrive as small JSON data URLs; every other request body stays tiny.
    const smallJson = express.json({ limit: '64kb' });
    const photoJson = express.json({ limit: '800kb' });
    app.use((req, res, next) => (req.path === '/users/me/avatar' ? photoJson : smallJson)(req, res, next));
    const cookie = sessionCookie(env.NODE_ENV === 'production');
    app.use(createSessionMiddleware(pool, { secret: env.SESSION_SECRET, cookie }));

    const userRepository = createUserRepository(pool);
    const userService = createUserService(userRepository);
    const authMiddleware = createAuthMiddleware(userRepository);
    const authService = createAuthService({
        users: userRepository,
        mailer: createMailer(env.SMTP, env.NODE_ENV, { log: message => logger.info(message), warn: message => logger.warn(message) }),
        publicOrigin: env.PUBLIC_ORIGIN,
        logger,
    });

    app.post(
        '/auth/login',
        throttle(
            pool,
            env.SESSION_SECRET,
            'login',
            { perIp: 50, perAccount: 10 },
            'Too many sign-in attempts. Wait 15 minutes and try again.',
        ),
    );
    app.post('/auth/register', throttle(pool, env.SESSION_SECRET, 'register', { perIp: 20, perAccount: 5 }));
    app.post('/auth/forgot', throttle(pool, env.SESSION_SECRET, 'forgot', { perIp: 20, perAccount: 5 }));
    app.post('/auth/reset', throttle(pool, env.SESSION_SECRET, 'reset', { perIp: 30 }));
    // A stolen session must not be usable to guess the current password, flood other people with mail or hammer the providers.
    app.post('/auth/password', throttle(pool, env.SESSION_SECRET, 'password', { perUser: 10 }));
    app.post(
        ['/emails/compose', '/emails/:id/send'],
        throttle(pool, env.SESSION_SECRET, 'send', { perUser: 60 }, 'Too many messages sent. Wait 15 minutes and try again.'),
    );
    app.get('/accounts/connect/:provider', throttle(pool, env.SESSION_SECRET, 'connect', { perUser: 30 }));
    app.put('/users/me/avatar', throttle(pool, env.SESSION_SECRET, 'avatar', { perUser: 30 }));
    app.use(
        '/auth',
        createAuthRouter({
            users: userService,
            auth: authService,
            requireAuth: authMiddleware.requireAuth,
            allowRegistration: env.ALLOW_REGISTRATION,
            cookie,
            audit,
        }),
    );

    app.use('/users', createUserRouter({ users: userService, requireAuth: authMiddleware.requireAuth }));

    const accounts = createAccountsRepository(pool, createTokenVault(env.TOKEN_ENCRYPTION_KEY, env.TOKEN_ENCRYPTION_KEY_PREVIOUS));
    const registry = createMailRegistry({
        outlook: env.MICROSOFT ? { ...env.MICROSOFT, redirectUri: `${env.PUBLIC_ORIGIN}/accounts/callback/outlook` } : undefined,
        gmail: env.GOOGLE ? { ...env.GOOGLE, redirectUri: `${env.PUBLIC_ORIGIN}/accounts/callback/gmail` } : undefined,
        store: accounts.credentialStore,
    });
    const emailService = createEmailService(createEmailRepository(pool), accounts, registry);
    app.use(
        '/accounts',
        createAccountsRouter({
            accounts,
            registry,
            emails: emailService,
            requireAuth: authMiddleware.requireAuth,
            allowedGmail: env.GMAIL_ALLOWED_EMAILS,
            audit,
        }),
    );
    app.use('/emails', createEmailRouter({ service: emailService, requireAuth: authMiddleware.requireAuth, audit }));

    app.get('/health', async (_req, res) => {
        await pool.query('SELECT 1');
        res.json({ status: 'ok' });
    });

    app.use(
        express.static(publicDirectory, {
            // Scripts, styles and icons hold no personal data. The browser may keep them but must ask before each use
            // (no-cache): an unchanged file costs a 304 with no body, and a deploy is picked up at once.
            // Pages keep no-store: browsers never put such a page in the back/forward cache, so pressing Back after
            // signing out cannot redisplay an inbox as it was rendered.
            setHeaders(res, path) {
                res.setHeader('Cache-Control', path.endsWith('.html') ? 'no-store' : 'no-cache');
            },
            dotfiles: 'ignore',
        }),
    );
    app.use(notFoundMiddleware);
    app.use(errorMiddleware);

    return app;
}
