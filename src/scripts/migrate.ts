import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { connectionOptions } from '../config/database.js';
import { env } from '../config/env.js';

// Usage: migrate.js            apply every pending migration
//        migrate.js down <n>   roll back the last n migrations (used in CI to prove every Down section works)
async function main(): Promise<void> {
    const [direction = 'up', countText] = process.argv.slice(2);
    if (direction !== 'up' && direction !== 'down') throw new Error('Use "up" or "down <count>".');
    const count = direction === 'down' ? Number(countText) : Number.POSITIVE_INFINITY;
    if (direction === 'down' && !(Number.isInteger(count) && count > 0)) throw new Error('Give the number of migrations to roll back.');
    await runner({
        databaseUrl: connectionOptions(env),
        dir: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
        migrationsTable: 'pgmigrations',
        direction,
        count,
        checkOrder: true,
        singleTransaction: true,
    });
    console.log(direction === 'up' ? 'Database migrations completed.' : `Rolled back ${count} migration(s).`);
}

main().catch((error: unknown) => {
    console.error('Database migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
