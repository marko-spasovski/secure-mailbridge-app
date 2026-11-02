import type { ConnectionOptions } from 'node:tls';
import { type ClientConfig, Pool, type PoolClient } from 'pg';
import type { Logger } from './logger.js';

export interface DatabaseConfig {
    POSTGRES_HOST: string;
    POSTGRES_PORT: number;
    POSTGRES_DB: string;
    POSTGRES_USER: string;
    POSTGRES_PASSWORD: string;
    // false: plain TCP. Otherwise TLS with full verification; `ca` replaces the system trust store when given.
    POSTGRES_SSL: false | { ca: string | undefined };
}

// TLS to PostgreSQL always verifies both the certificate chain and that the certificate names POSTGRES_HOST
// (Node's default checkServerIdentity). There is deliberately no "encrypt but don't verify" mode: without
// verification anyone on the path can present their own certificate and read everything, password exchange included.
export function databaseTls(ssl: DatabaseConfig['POSTGRES_SSL']): false | ConnectionOptions {
    if (!ssl) return false;
    return { rejectUnauthorized: true, ...(ssl.ca ? { ca: ssl.ca } : {}) };
}

// The one place that turns configuration into connection settings: the app's pool and the migrator both use it.
export const connectionOptions = (config: DatabaseConfig): ClientConfig => ({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    database: config.POSTGRES_DB,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
    ssl: databaseTls(config.POSTGRES_SSL),
    connectionTimeoutMillis: 5_000,
});

// Only entry points (server, scripts, tests) create a pool; everything else receives it as a parameter.
export function createPool(config: DatabaseConfig, logger?: Pick<Logger, 'error'>): Pool {
    const pool = new Pool({
        ...connectionOptions(config),
        max: 10,
        idleTimeoutMillis: 30_000,
    });
    // Handles unexpected errors from connections sitting idle in the pool.
    pool.on('error', error => {
        logger?.error({ event: 'pool-error', err: error }, 'unexpected PostgreSQL pool error');
    });
    return pool;
}

// Runs `work` inside BEGIN/COMMIT on one connection. Any error rolls back and is rethrown.
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export const REQUIRED_TABLES = [
    'users',
    'sessions',
    'login_attempts',
    'password_resets',
    'user_avatars',
    'mail_accounts',
    'emails',
    'email_bodies',
    'outgoing_messages',
    'audit_events',
] as const;

// Call and await this during startup, before app.listen().
export async function checkDatabaseConnection(pool: Pool): Promise<void> {
    await pool.query('SELECT 1');
    const result = await pool.query<{ name: string }>('SELECT t AS name FROM unnest($1::text[]) AS t WHERE to_regclass(t) IS NULL', [
        REQUIRED_TABLES,
    ]);
    const missing = result.rows[0]?.name;
    if (missing) throw new Error(`Missing database table ${missing}. Run migrations before starting the server.`);
}
