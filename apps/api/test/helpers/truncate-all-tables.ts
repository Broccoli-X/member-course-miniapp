import type { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Truncate EVERY business table in the `member_course_test` database.
 *
 * Why this exists: the e2e and integration suites share a single physical
 * MySQL test DB and run with `fileParallelism: false`. Each spec's
 * `beforeEach` used to hand-list the tables it "thought it touched", and
 * earlier specs left residue in tables the next spec never cleared. That
 * cross-file residue produced intermittent CI failures (e.g. a stale
 * `member_account` phone colliding, or a stale `course_package` skewing a
 * count). Truncating the full set on every test boundary is the only way to
 * guarantee complete isolation regardless of which spec ran previously.
 *
 * Implementation notes:
 *  - The table list is read from `information_schema` (filtered to the test
 *    DB, excluding Prisma's own `_prisma_migrations` bookkeeping table) so the
 *    helper keeps working as the schema grows without any spec edits.
 *  - `SET FOREIGN_KEY_CHECKS = 0` wraps the loop so child tables can be
 *    cleared before their parents; the flag is always restored in `finally`.
 *  - This is a no-op on an already-empty DB and is safe to call from
 *    `beforeEach` (per-test) or `afterEach`.
 *
 * @param db any Prisma client bound to the `member_course_test` DB
 *   (the `PrismaService` exposed by the Nest module or a standalone
 *   `PrismaClient`; both expose `$queryRaw` / `$executeRawUnsafe`).
 */
export async function truncateAllTables(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRaw<{ TABLE_NAME: string }[]>`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME NOT LIKE '\\_prisma\\_%'
  `;

  await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
  try {
    for (const { TABLE_NAME } of tables) {
      // TABLE_NAME comes from information_schema (a trusted system catalog),
      // never user input, so it is safe to interpolate into the statement.
      await db.$executeRawUnsafe(`TRUNCATE TABLE \`${TABLE_NAME}\``);
    }
  } finally {
    await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
  }
}
