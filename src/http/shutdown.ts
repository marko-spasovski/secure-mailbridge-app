import type { Server } from 'node:http';
import type { Logger } from '../config/logger.js';

// Docker sends SIGTERM, waits (10 s by default) and then SIGKILLs. Finish within that window ourselves, so the pool
// is closed cleanly and the exit is logged, instead of being cut off mid-write.
export const SHUTDOWN_DEADLINE_MS = 8_000;

// Stops accepting connections, lets in-flight requests finish for up to `deadlineMs`, then closes whatever is left
// (a long provider sync or a keep-alive connection from the proxy) and ends the database pool.
export async function shutdown(
    server: Server,
    pool: { end(): Promise<void> },
    logger: Pick<Logger, 'info' | 'warn'>,
    deadlineMs = SHUTDOWN_DEADLINE_MS,
): Promise<void> {
    const closed = new Promise<void>(resolve => {
        server.close(() => resolve());
    });
    server.closeIdleConnections();
    const deadline = setTimeout(() => {
        logger.warn({ event: 'shutdown-deadline', deadlineMs }, 'requests still running at the shutdown deadline; closing them');
        server.closeAllConnections();
    }, deadlineMs);
    try {
        await closed;
    } finally {
        clearTimeout(deadline);
    }
    await pool.end();
    logger.info({ event: 'shutdown-complete' }, 'shut down');
}
