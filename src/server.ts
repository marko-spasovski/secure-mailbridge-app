import { createApp } from './app.js';
import { checkDatabaseConnection, createPool } from './config/database.js';
import { env } from './config/env.js';
import { createLogger } from './config/logger.js';
import { shutdown } from './http/shutdown.js';

const logger = createLogger({ level: env.LOG_LEVEL });
const pool = createPool(env, logger);
try {
    await checkDatabaseConnection(pool);
    logger.info('PostgreSQL connection and schema checks successful');
    const server = createApp({ pool, env, logger }).listen(env.PORT, () => logger.info({ port: env.PORT }, 'server listening'));
    server.on('error', async error => {
        logger.fatal({ err: error }, 'server startup failed');
        await pool.end();
        process.exitCode = 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, async () => {
            logger.info({ signal }, 'shutting down');
            try {
                await shutdown(server, pool, logger);
            } catch (error) {
                logger.error({ err: error }, 'shutdown failed');
                process.exitCode = 1;
            }
            // Exit now: a provider retry timer from a request that was cut off could otherwise keep the process alive.
            process.exit();
        });
} catch (error) {
    logger.fatal({ err: error }, 'database unavailable; check the configuration and run the migrations');
    await pool.end();
    process.exitCode = 1;
}
