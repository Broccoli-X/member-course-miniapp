import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getMysqlContext, type MysqlTestContext } from '../../helpers/mysql-test-environment.js';
import {
  seedMemberStudentCourse,
  seedConfirmedOrderFixture,
  createDuplicateBalance,
  createDuplicateAccountStudentRelation,
  createDuplicateIdempotencyKey,
} from '../../helpers/m1-schema-fixtures.js';
import { PrismaClient } from '../../../src/generated/prisma/client.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('M1 schema constraints', () => {
  let ctx: MysqlTestContext | null;
  let db: PrismaClient;

  beforeAll(async () => {
    ctx = await getMysqlContext();
    if (!ctx) return;
    db = new PrismaClient({ datasources: { db: { url: ctx.databaseUrl } } });
  });

  beforeEach(async () => {
    if (!ctx) return;
    const tables = await db.$queryRaw<{ TABLE_NAME: string }[]>`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = 'member_course_test'
    `;
    // FK checks must be disabled around the truncate loop: child tables
    // (e.g. refresh_session) reference parent tables (admin_user/member_account)
    // and MySQL refuses TRUNCATE on a referenced table otherwise. Mirrors the
    // cleanup path in helpers/mysql-test-environment.ts.
    await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      for (const { TABLE_NAME } of tables) {
        await db.$executeRawUnsafe(`TRUNCATE TABLE \`${TABLE_NAME}\``);
      }
    } finally {
      await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('enforces M1 ownership and idempotency constraints', async () => {
    if (!ctx) return;
    await seedMemberStudentCourse(db);
    await expect(createDuplicateBalance(db)).rejects.toMatchObject({ code: 'P2002' });
    await expect(createDuplicateAccountStudentRelation(db)).rejects.toMatchObject({ code: 'P2002' });
    await expect(createDuplicateIdempotencyKey(db)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('prevents deleting referenced catalog and member records', async () => {
    if (!ctx) return;
    const fixture = await seedConfirmedOrderFixture(db);
    await expect(db.course.delete({ where: { id: fixture.courseId } })).rejects.toBeDefined();
    await expect(
      db.studentProfile.delete({ where: { id: fixture.studentId } }),
    ).rejects.toBeDefined();
  });
});
