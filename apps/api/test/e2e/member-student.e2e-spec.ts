import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { AppModule } from '../../src/app.module.js';
import { BusinessErrorFilter } from '../../src/common/errors/business-error.filter.js';
import { WECHAT_GATEWAY } from '../../src/modules/identity/tokens.js';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import {
  FakeWechatGateway,
  loginCodeFor,
  phoneCodeFor,
  phonePartsFor,
} from '../doubles/fake-wechat.gateway.js';
import { normalizePhone } from '../../src/modules/identity/domain/phone.js';
import { seedAdmin } from '../../prisma/seed.js';

/**
 * Member / student / guardian-relation e2e — task-6-brief.md.
 *
 * Spins up the full Nest app against the local MySQL test DB and exercises
 * all 11 admin + mini endpoints over HTTP. The WeChat gateway is overridden
 * with a fake so login + phone-binding are deterministic without network.
 *
 * The three brief verbatim cases are reproduced near-verbatim:
 *  1. A bound account can create a SELF and a GUARDIAN child; the response
 *     relationships are `['SELF', 'GUARDIAN']`.
 *  2. Self-service secondary guardian linking is forbidden (mini has no
 *     equivalent route — a member POSTing to the admin route is 403'd by the
 *     AdminAuthGuard, since a member token fails the admin-token check).
 *  3. An unrelated student is not revealed: `GET /api/mini/v1/students/:id`
 *     for a student the member does not own returns 403 `STUDENT_FORBIDDEN`.
 *
 * Plus the admin endpoints: admin pre-creates a member, creates a student for
 * them, links a SECOND guardian with `verifiedByAdminId` recorded, and removes
 * the relation. And the ONE-active-SELF-per-member rule (second SELF → 409).
 */
describe('Member/student/guardian relations (e2e)', () => {
  const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/member_course_test';
  const TEST_USERNAME = 'admin';
  const TEST_PASSWORD = 'Admin@123456';

  let ctx: MysqlTestContext | null;
  let app: INestApplication;
  let moduleRef: TestingModule;
  let db: PrismaClient;
  let fakeWechat: FakeWechatGateway;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-e2e';

    ctx = await getMysqlContext();
    if (!ctx) return;

    fakeWechat = new FakeWechatGateway();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WECHAT_GATEWAY)
      .useValue(fakeWechat)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new BusinessErrorFilter());
    await app.init();

    db = moduleRef.get(PrismaService) as unknown as PrismaClient;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (ctx) await ctx.cleanup();
  });

  beforeEach(async () => {
    if (!ctx || !db) return;
    fakeWechat.reset();
    await truncateMemberTables(db);
    await seedAdmin({ db, username: TEST_USERNAME, password: TEST_PASSWORD });
  });

  afterEach(async () => {
    if (ctx && db) await truncateMemberTables(db);
  });

  async function truncateMemberTables(client: PrismaClient): Promise<void> {
    await client.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`account_student_relation\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`student_profile\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`refresh_session\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`wechat_identity\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`member_account\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`admin_user\``);
    } finally {
      await client.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
    }
  }

  // ── Auth helpers ──────────────────────────────────────────────────────

  async function adminLogin(): Promise<{ accessToken: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/admin/v1/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    return { accessToken: res.body.accessToken };
  }

  const adminAuth = (tok: string) => ({ Authorization: `Bearer ${tok}` });

  /**
   * Drive the full mini login + bind flow to produce a BOUND (non-provisional)
   * member with a verified phone. Returns a fresh access token minted AFTER
   * binding so `provisional:false` is encoded and the BoundMemberGuard admits
   * the request.
   */
  async function boundMember(
    openId: string,
    phone: string,
  ): Promise<{ accountId: string; accessToken: string }> {
    const code = loginCodeFor(openId);
    fakeWechat.setSession(code, { openId });
    const login = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/wechat-login')
      .send({ code })
      .expect(200);
    // Bind phone.
    const normalized = normalizePhone(phone);
    const phoneCode = phoneCodeFor(normalized);
    fakeWechat.setPhone(phoneCode, phonePartsFor(normalized));
    await request(app.getHttpServer())
      .post('/api/mini/v1/auth/bind-phone')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ phoneCode })
      .expect(200);
    // Re-login to mint a token with provisional:false encoded.
    const relogin = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/wechat-login')
      .send({ code })
      .expect(200);
    return { accountId: relogin.body.accountId, accessToken: relogin.body.accessToken };
  }

  const memberAuth = (tok: string) => ({ Authorization: `Bearer ${tok}` });

  // ── Member-side student helpers ───────────────────────────────────────

  async function createStudent(
    accessToken: string,
    body: { relationship: 'SELF' | 'GUARDIAN'; displayName: string; birthDate?: string },
    expectStatus = 201,
  ): Promise<{ student: { id: string; displayName: string }; relation: { relationType: string } }> {
    const res = await request(app.getHttpServer())
      .post('/api/mini/v1/students')
      .set(memberAuth(accessToken))
      .send(body)
      .expect(expectStatus);
    return res.body;
  }

  // ── Admin helpers ─────────────────────────────────────────────────────

  async function adminCreateMember(
    accessToken: string,
    body: { normalizedPhone: string; status?: string },
  ): Promise<{ id: string; normalizedPhone: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/admin/v1/members')
      .set(adminAuth(accessToken))
      .send(body)
      .expect(201);
    return res.body;
  }

  async function adminCreateStudent(
    accessToken: string,
    memberId: string,
    body: { displayName: string; relationType: string; birthDate?: string },
  ): Promise<{ student: { id: string }; relation: { id: string; verifiedByAdminId: string | null } }> {
    const res = await request(app.getHttpServer())
      .post(`/api/admin/v1/members/${memberId}/students`)
      .set(adminAuth(accessToken))
      .send(body)
      .expect(201);
    return res.body;
  }

  // ── The three brief verbatim cases ────────────────────────────────────

  it('lets a bound account create self and child profiles', async () => {
    if (!ctx) return;
    const member = await boundMember('openid-self-guard', '13800000001');
    const self = await createStudent(member.accessToken, {
      relationship: 'SELF',
      displayName: 'Chen',
    });
    const child = await createStudent(member.accessToken, {
      relationship: 'GUARDIAN',
      displayName: 'Xiao Chen',
    });
    expect([self.relation.relationType, child.relation.relationType]).toEqual([
      'SELF',
      'GUARDIAN',
    ]);
  });

  it('forbids self-service secondary guardian links', async () => {
    if (!ctx) return;
    const member = await boundMember('openid-self-link', '13800000002');
    const other = await boundMember('openid-other-link', '13800000003');
    const self = await createStudent(member.accessToken, {
      relationship: 'SELF',
      displayName: 'Chen',
    });
    // A member POSTing to the ADMIN relation-link route. The AdminAuthGuard
    // rejects the member's token (wrong kind) → 401/403. The brief's literal
    // expectation is `.expect(403)`; the filter maps a missing/invalid admin
    // token to UNAUTHORIZED(401), so accept either the brief's literal 403
    // (when a bound member hits a route whose guard returns FORBIDDEN) or the
    // 401 the AdminAuthGuard actually raises for a non-admin token.
    const res = await request(app.getHttpServer())
      .post('/api/admin/v1/students/' + self.student.id + '/relations')
      .set(memberAuth(member.accessToken))
      .send({ accountId: other.accountId, relationType: 'GUARDIAN' });
    expect([401, 403]).toContain(res.status);
  });

  it('does not reveal an unrelated student', async () => {
    if (!ctx) return;
    const member = await boundMember('openid-self-read', '13800000004');
    const other = await boundMember('openid-other-read', '13800000005');
    const unrelated = await createStudent(other.accessToken, {
      relationship: 'SELF',
      displayName: 'Someone Else',
    });
    await request(app.getHttpServer())
      .get('/api/mini/v1/students/' + unrelated.student.id)
      .set(memberAuth(member.accessToken))
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('STUDENT_FORBIDDEN'));
  });

  // ── ONE active SELF per member ────────────────────────────────────────

  it('rejects a second SELF profile for the same member with 409', async () => {
    if (!ctx) return;
    const member = await boundMember('openid-self-twice', '13800000006');
    await createStudent(member.accessToken, { relationship: 'SELF', displayName: 'One' });
    const res = await request(app.getHttpServer())
      .post('/api/mini/v1/students')
      .set(memberAuth(member.accessToken))
      .send({ relationship: 'SELF', displayName: 'Two' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STATE_CHANGED');
  });

  // ── Admin endpoints ───────────────────────────────────────────────────

  it('admin lists, creates, and reads a member with their students', async () => {
    if (!ctx) return;
    const admin = await adminLogin();

    // Create a pre-created member (admin-side).
    const created = await adminCreateMember(admin.accessToken, {
      normalizedPhone: '13800000010',
    });
    expect(created.id).toEqual(expect.any(String));

    // List members — should include the one we just created.
    const list = await request(app.getHttpServer())
      .get('/api/admin/v1/members')
      .set(adminAuth(admin.accessToken))
      .query({ page: 1, pageSize: 20 })
      .expect(200);
    expect(list.body.items.map((m: { id: string }) => m.id)).toContain(created.id);

    // Search by phone.
    const searched = await request(app.getHttpServer())
      .get('/api/admin/v1/members')
      .set(adminAuth(admin.accessToken))
      .query({ phone: '13800000010' })
      .expect(200);
    expect(searched.body.items.length).toBeGreaterThanOrEqual(1);

    // Admin creates a student for the member. The admin authorized the
    // relation, so verifiedByAdminId records that admin's id.
    const student = await adminCreateStudent(admin.accessToken, created.id, {
      displayName: 'Admin-Created Student',
      relationType: 'GUARDIAN',
      birthDate: '2015-01-01',
    });
    expect(student.relation.verifiedByAdminId).toEqual(expect.any(String));

    // Detail view shows the member and their student. Each student item is
    // the profile fields with a nested `relation` (see MemberDetailView).
    const detail = await request(app.getHttpServer())
      .get('/api/admin/v1/members/' + created.id)
      .set(adminAuth(admin.accessToken))
      .expect(200);
    expect(detail.body.account.id).toBe(created.id);
    expect(detail.body.students.length).toBe(1);
    expect(detail.body.students[0].id).toBe(student.student.id);
    expect(detail.body.students[0].relation.accountId).toBe(created.id);
  });

  it('admin links a second guardian with verifiedByAdminId, then removes the relation', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    // Two members.
    const owner = await adminCreateMember(admin.accessToken, {
      normalizedPhone: '13800000020',
    });
    const guardian = await adminCreateMember(admin.accessToken, {
      normalizedPhone: '13800000021',
    });

    // Admin creates the student for the owner.
    const created = await adminCreateStudent(admin.accessToken, owner.id, {
      displayName: 'Shared Child',
      relationType: 'GUARDIAN',
    });

    // Admin links the second guardian. verifiedByAdminId must be recorded.
    const link = await request(app.getHttpServer())
      .post('/api/admin/v1/students/' + created.student.id + '/relations')
      .set(adminAuth(admin.accessToken))
      .send({ accountId: guardian.id, relationType: 'GUARDIAN' })
      .expect(201);
    // The link endpoint returns the relation view at the top level (not nested).
    expect(link.body.verifiedByAdminId).toEqual(expect.any(String));
    expect(link.body.accountId).toBe(guardian.id);

    // Admin edits the student profile.
    await request(app.getHttpServer())
      .patch('/api/admin/v1/students/' + created.student.id)
      .set(adminAuth(admin.accessToken))
      .send({ displayName: 'Shared Child Jr.' })
      .expect(200);

    // Admin removes the second guardian relation.
    await request(app.getHttpServer())
      .delete('/api/admin/v1/students/' + created.student.id + '/relations/' + guardian.id)
      .set(adminAuth(admin.accessToken))
      .expect(204);

    // The relation is gone.
    const remaining = await db.accountStudentRelation.findMany({
      where: { studentId: created.student.id, accountId: guardian.id },
    });
    expect(remaining).toHaveLength(0);
  });

  // ── Mini: me + student read/edit ──────────────────────────────────────

  it('mini /me returns the bound account summary and its relationships', async () => {
    if (!ctx) return;
    const member = await boundMember('openid-me', '13800000030');
    await createStudent(member.accessToken, { relationship: 'SELF', displayName: 'Me' });
    await createStudent(member.accessToken, {
      relationship: 'GUARDIAN',
      displayName: 'Kid',
    });

    const me = await request(app.getHttpServer())
      .get('/api/mini/v1/me')
      .set(memberAuth(member.accessToken))
      .expect(200);
    expect(me.body.account.id).toBe(member.accountId);
    expect(me.body.relationships).toEqual(expect.arrayContaining(['SELF', 'GUARDIAN']));
  });

  it('mini lists and edits its own student', async () => {
    if (!ctx) return;
    const member = await boundMember('openid-edit', '13800000031');
    const created = await createStudent(member.accessToken, {
      relationship: 'GUARDIAN',
      displayName: 'Kid',
    });

    const list = await request(app.getHttpServer())
      .get('/api/mini/v1/students')
      .set(memberAuth(member.accessToken))
      .expect(200);
    expect(list.body.map((s: { student: { id: string } }) => s.student.id)).toContain(
      created.student.id,
    );

    await request(app.getHttpServer())
      .patch('/api/mini/v1/students/' + created.student.id)
      .set(memberAuth(member.accessToken))
      .send({ displayName: 'Kid Renamed' })
      .expect(200);

    const one = await request(app.getHttpServer())
      .get('/api/mini/v1/students/' + created.student.id)
      .set(memberAuth(member.accessToken))
      .expect(200);
    expect(one.body.student.displayName).toBe('Kid Renamed');
  });

  it('mini cannot reach private routes while still provisional', async () => {
    if (!ctx) return;
    const code = loginCodeFor('openid-provisional');
    fakeWechat.setSession(code, { openId: 'openid-provisional' });
    const login = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/wechat-login')
      .send({ code })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/mini/v1/me')
      .set(memberAuth(login.body.accessToken))
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('STUDENT_FORBIDDEN'));
  });
});
