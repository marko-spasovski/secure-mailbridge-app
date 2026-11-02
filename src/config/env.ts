import 'dotenv/config';
import { z } from 'zod';

// Every setting the app reads, checked once at startup. A bad value stops the process with the setting's name,
// never its value (values may be secrets). Nothing else in src/ reads process.env, except the one-off scripts.

const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const text = () => z.preprocess(blankToUndefined, z.string().trim());
const optionalText = () => z.preprocess(blankToUndefined, z.string().trim().optional());
const port = () => z.coerce.number().int().min(1).max(65535);
const flag = (fallback: boolean) =>
    z
        .preprocess(blankToUndefined, z.enum(['true', 'false']).optional())
        .transform(value => (value === undefined ? fallback : value === 'true'));

const schema = z
    .object({
        NODE_ENV: z.enum(['development', 'test', 'production']),
        PORT: z.preprocess(blankToUndefined, port().default(3000)),
        LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')),
        // Where people reach the app, e.g. https://mail.example.com (no trailing slash). Required in production.
        PUBLIC_ORIGIN: optionalText(),
        // How many reverse proxies in front of the app may set X-Forwarded-For (0 = none, 1 = Caddy).
        TRUST_PROXY: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(3).default(0)),
        SESSION_SECRET: text(),
        // Encrypts stored mailbox credentials. Falls back to SESSION_SECRET outside production.
        TOKEN_ENCRYPTION_KEY: optionalText(),
        // Only while rotating: the old key, still accepted for reading. See docs/runbooks/key-rotation.md.
        TOKEN_ENCRYPTION_KEY_PREVIOUS: optionalText(),

        POSTGRES_HOST: text(),
        POSTGRES_PORT: port(),
        POSTGRES_DB: text(),
        POSTGRES_USER: text(),
        POSTGRES_PASSWORD: text(),

        // Anyone may create an account unless this is switched off.
        ALLOW_REGISTRATION: flag(true),
        MICROSOFT_CLIENT_ID: optionalText(),
        MICROSOFT_CLIENT_SECRET: optionalText(),
        // Accounts from any Microsoft tenant or personal Microsoft account by default.
        MICROSOFT_TENANT: z.preprocess(blankToUndefined, z.string().trim().default('common')),
        GOOGLE_CLIENT_ID: optionalText(),
        GOOGLE_CLIENT_SECRET: optionalText(),
        // Optional invite list for Gmail (comma-separated sign-in emails of this app's users). Empty means everyone.
        // Useful while the Google app is unverified and only a few people can connect anyway.
        GMAIL_ALLOWED_EMAILS: z.preprocess(
            value => (typeof value === 'string' ? value : ''),
            z.string().transform(value =>
                value
                    .split(',')
                    .map(item => item.trim().toLowerCase())
                    .filter(Boolean),
            ),
        ),

        SMTP_HOST: optionalText(),
        SMTP_PORT: z.preprocess(blankToUndefined, port().default(587)),
        SMTP_SECURE: z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional()),
        SMTP_USER: optionalText(),
        SMTP_PASSWORD: optionalText(),
        SMTP_FROM: optionalText(),
    })
    .superRefine((value, context) => {
        const problem = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
        // Both halves of an OAuth app registration must be present, or neither.
        for (const prefix of ['MICROSOFT', 'GOOGLE'] as const)
            if (!value[`${prefix}_CLIENT_ID`] !== !value[`${prefix}_CLIENT_SECRET`])
                problem(`${prefix}_CLIENT_ID`, `Set both ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET, or neither.`);
        if (value.SMTP_HOST && !value.SMTP_FROM) problem('SMTP_FROM', 'SMTP_FROM is required when SMTP_HOST is set.');
        if (value.PUBLIC_ORIGIN) {
            let origin: URL | undefined;
            try {
                origin = new URL(value.PUBLIC_ORIGIN);
            } catch {
                origin = undefined;
            }
            if (origin?.origin !== value.PUBLIC_ORIGIN)
                problem(
                    'PUBLIC_ORIGIN',
                    'PUBLIC_ORIGIN must be an origin such as https://mail.example.com, without a path or trailing slash.',
                );
        }
        if (value.NODE_ENV !== 'production') return;
        if (!value.PUBLIC_ORIGIN?.startsWith('https://'))
            problem('PUBLIC_ORIGIN', 'Production needs PUBLIC_ORIGIN set to an https:// origin.');
        // The app never terminates TLS itself, so in production a proxy always does. Without trusting it, every
        // request looks like plain HTTP: express-session then silently drops the Secure session cookie (sign-in seems
        // to work but nobody stays signed in) and throttling counts every client as the proxy's address.
        if (value.TRUST_PROXY < 1)
            problem('TRUST_PROXY', 'Production runs behind a TLS-terminating proxy: set TRUST_PROXY to the number of proxies (usually 1).');
        for (const name of ['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY'] as const) {
            const secret = value[name] ?? '';
            if (secret.length < 32 || secret.startsWith('REPLACE_'))
                problem(name, `Production needs ${name} with at least 32 random characters.`);
        }
        if (value.SESSION_SECRET === value.TOKEN_ENCRYPTION_KEY)
            problem('TOKEN_ENCRYPTION_KEY', 'TOKEN_ENCRYPTION_KEY must differ from SESSION_SECRET.');
        const previous = value.TOKEN_ENCRYPTION_KEY_PREVIOUS;
        if (previous !== undefined && (previous.length < 32 || previous === value.TOKEN_ENCRYPTION_KEY))
            problem(
                'TOKEN_ENCRYPTION_KEY_PREVIOUS',
                'TOKEN_ENCRYPTION_KEY_PREVIOUS must be the old key: at least 32 characters, not the current one.',
            );
    });

export function loadEnv(source: NodeJS.ProcessEnv) {
    // Render provides the service's public address; use it until PUBLIC_ORIGIN is set explicitly.
    const input = { ...source, PUBLIC_ORIGIN: source.PUBLIC_ORIGIN?.trim() || source.RENDER_EXTERNAL_URL };
    const result = schema.safeParse(input);
    if (!result.success) {
        const lines = result.error.issues.map(issue => `  ${issue.path.join('.') || '(environment)'}: ${issue.message}`);
        throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
    }
    const value = result.data;
    return {
        NODE_ENV: value.NODE_ENV,
        PORT: value.PORT,
        LOG_LEVEL: value.LOG_LEVEL,
        // Used for links in mail and OAuth redirect URIs. Falls back to localhost outside production.
        PUBLIC_ORIGIN: value.PUBLIC_ORIGIN ?? `http://localhost:${value.PORT}`,
        // The origin that state-changing requests must come from; null means "the host the request was sent to"
        // (development and tests only; production always sets PUBLIC_ORIGIN).
        EXPECTED_ORIGIN: value.PUBLIC_ORIGIN ?? null,
        TRUST_PROXY: value.TRUST_PROXY,
        SESSION_SECRET: value.SESSION_SECRET,
        TOKEN_ENCRYPTION_KEY: value.TOKEN_ENCRYPTION_KEY ?? value.SESSION_SECRET,
        TOKEN_ENCRYPTION_KEY_PREVIOUS: value.TOKEN_ENCRYPTION_KEY_PREVIOUS,
        POSTGRES_HOST: value.POSTGRES_HOST,
        POSTGRES_PORT: value.POSTGRES_PORT,
        POSTGRES_DB: value.POSTGRES_DB,
        POSTGRES_USER: value.POSTGRES_USER,
        POSTGRES_PASSWORD: value.POSTGRES_PASSWORD,
        ALLOW_REGISTRATION: value.ALLOW_REGISTRATION,
        MICROSOFT:
            value.MICROSOFT_CLIENT_ID && value.MICROSOFT_CLIENT_SECRET
                ? { clientId: value.MICROSOFT_CLIENT_ID, clientSecret: value.MICROSOFT_CLIENT_SECRET, tenant: value.MICROSOFT_TENANT }
                : undefined,
        GOOGLE:
            value.GOOGLE_CLIENT_ID && value.GOOGLE_CLIENT_SECRET
                ? { clientId: value.GOOGLE_CLIENT_ID, clientSecret: value.GOOGLE_CLIENT_SECRET }
                : undefined,
        GMAIL_ALLOWED_EMAILS: value.GMAIL_ALLOWED_EMAILS,
        SMTP:
            value.SMTP_HOST && value.SMTP_FROM
                ? {
                      host: value.SMTP_HOST,
                      port: value.SMTP_PORT,
                      secure: value.SMTP_SECURE ? value.SMTP_SECURE === 'true' : value.SMTP_PORT === 465,
                      user: value.SMTP_USER,
                      password: value.SMTP_PASSWORD,
                      from: value.SMTP_FROM,
                  }
                : undefined,
    };
}

export type Env = ReturnType<typeof loadEnv>;
export const env: Env = loadEnv(process.env);
