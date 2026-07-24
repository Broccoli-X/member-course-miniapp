import { execSync } from 'node:child_process';
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
 * Checks whether a local MySQL instance is reachable on the test port.
 * Integration tests are skipped (not failed) when no DB is available,
 * so the workspace still passes `pnpm test` without Docker.
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

  // Run migration
  execSync(`npx prisma migrate deploy --schema prisma/schema.prisma`, {
    env: { ...process.env, DATABASE_URL: DEFAULT_URL },
    stdio: 'pipe',
  });

  const { PrismaClient } = await import('../src/generated/prisma/client.js');
  const db = new PrismaClient({ datasources: { db: { url: DEFAULT_URL } } });

  return {
    databaseUrl: DEFAULT_URL,
    cleanup: async () => {
      // Truncate all tables for isolation between tests
      const tables = await db.$queryRaw<{ TABLE_NAME: string }[]>`
        SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = 'member_course_test'
      `;
      for (const { TABLE_NAME } of tables) {
        await db.$executeRawUnsafe(`TRUNCATE TABLE \`${TABLE_NAME}\``);
      }
      await db.$disconnect();
    },
  };
}
