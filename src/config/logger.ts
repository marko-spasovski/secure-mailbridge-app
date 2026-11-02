import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';

export type { Logger };

// Anything that could hold a credential or personal data is replaced before a line is written.
// Request URLs are logged as the path only: query strings carry OAuth codes, search words and cursors.
export const REDACTED_PATHS = [
    'req.headers.cookie',
    'req.headers.authorization',
    'res.headers["set-cookie"]',
    '*.password',
    '*.currentPassword',
    '*.newPassword',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.credentials',
    '*.secret',
    '*.code',
];

// One JSON object per line on stdout; Docker's log driver (and later an off-server shipper) takes it from there.
export function createLogger(options: { level: string; destination?: pino.DestinationStream }): Logger {
    return pino(
        {
            level: options.level,
            base: { service: 'mailbridge' },
            timestamp: pino.stdTimeFunctions.isoTime,
            redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
            // Every line, not only request lines, logs errors without their message (see serializeError).
            serializers: { err: serializeError },
            formatters: { level: label => ({ level: label }) },
        },
        options.destination,
    );
}

// Health probes run every few seconds; logging them would bury everything else.
const HEALTH_PATHS = new Set(['/health', '/healthz']);

// Express rewrites req.url inside mounted routers; originalUrl keeps the full path.
const requestPath = (req: IncomingMessage) =>
    ((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '').split('?')[0];

// Errors are logged by type, code and stack frames. The message line is left out: driver and network errors can
// quote connection strings or other secrets. The request ID ties the line to what the person saw.
export function serializeError(error: unknown) {
    if (!(error instanceof Error)) return { type: typeof error };
    const code = 'code' in error ? String(error.code) : undefined;
    return { type: error.name, ...(code ? { code } : {}), stack: error.stack?.split('\n').slice(1).join('\n') };
}

// Gives every request an ID (sent back as X-Request-ID) and writes one line when it finishes.
// The ID is generated here, never taken from the client, so a caller cannot forge or collide log entries.
export function createRequestLogger(logger: Logger) {
    return pinoHttp({
        logger,
        genReqId: (_req: IncomingMessage, res: ServerResponse) => {
            const id = randomUUID();
            res.setHeader('X-Request-ID', id);
            return id;
        },
        autoLogging: { ignore: req => HEALTH_PATHS.has(requestPath(req) ?? '') },
        customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
        customSuccessMessage: (req, res) => `${req.method} ${requestPath(req)} ${res.statusCode}`,
        customErrorMessage: (req, res) => `${req.method} ${requestPath(req)} ${res.statusCode}`,
        // The session is absent on requests refused before it loads. `ip` honours the trust-proxy setting.
        customProps: req => {
            const request = req as IncomingMessage & { session?: { userId?: string }; ip?: string };
            return { userId: request.session?.userId, ip: request.ip };
        },
        serializers: {
            req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
                id: req.id,
                method: req.method,
                path: req.url.split('?')[0],
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            err: serializeError,
        },
        wrapSerializers: false,
        quietReqLogger: true,
    });
}
