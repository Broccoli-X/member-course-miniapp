import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MysqlTestContext {
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

const DEFAULT_URL =
  process.env.TEST_DATABASE_URL ??
  'mysql://root@127.0.0.1:3306/member_course_test';

/**
 * Probes a local MySQL test instance. Returns null (not throws) when the DB is
 * unreachable so callers can `describe.skipIf`/early-return — keeping
 * `pnpm test` green on machines without Docker.
 *
 * Migrations are applied idempotently via the local prisma binary (not `npx`,
 * which doesn't always resolve in monorepo sandboxes). When the schema is
 * already current the migrate-deploy step is a no-op.
 */
export async function getMysqlContext(): Promise<MysqlTestContext | null> {
  const schemaPath = resolve(process.cwd(), 'prisma/schema.prisma');

  if (!existsSync(schemaPath)) {
    return null;
  }

  // Try to connect — if MySQL isn't running, return null so tests skip.
  try {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection(DEFAULT_URL);
    await conn.ping();
    await conn.end();
  } catch {
    return null;
  }

  // Apply migrations via the local prisma binary so the helper doesn't depend
  // on `npx` resolving in every sandbox shape. Idempotent: a no-op when the
  // schema is already current. A failed deploy (e.g. already-applied, or an
  // env without the binary) is non-fatal — the connectivity check above is the
  // real gate.
  const prismaBin = resolve(process.cwd(), 'node_modules/.bin/prisma');
  if (existsSync(prismaBin)) {
    try {
      execFileSync(
        prismaBin,
        ['migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
        {
          env: { ...process.env, DATABASE_URL: DEFAULT_URL },
          stdio: 'pipe',
          cwd: process.cwd(),
        },
      );
    } catch {
      // Non-fatal: migrations may already be applied; the caller truncates and
      // seeds against whatever schema is present.
    }
  }

  const { PrismaClient } = await import('../../src/generated/prisma/client.js');
  const db = new PrismaClient({ datasources: { db: { url: DEFAULT_URL } } });

  return {
    databaseUrl: DEFAULT_URL,
    cleanup: async () => {
      // Truncate all tables for isolation between tests. FK checks are disabled
      // around the truncate loop so child tables can be cleared before parents.
      const tables = await db.$queryRaw<{ TABLE_NAME: string }[]>`
        SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = 'member_course_test'
      `;
      await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
      try {
        for (const { TABLE_NAME } of tables) {
          await db.$executeRawUnsafe(`TRUNCATE TABLE \`${TABLE_NAME}\``);
        }
      } finally {
        await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
        await db.$disconnect();
      }
    },
  };
}
