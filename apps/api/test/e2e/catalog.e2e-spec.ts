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
 * Course / package catalog e2e — task-7-brief.md.
 *
 * Spins up the full Nest app against the local MySQL test DB and exercises all
 * nine catalog endpoints (7 admin + 2 mini) over HTTP. The WeChat gateway is
 * faked so the bound-member fixture for the mini public routes is deterministic
 * without network.
 *
 * The two brief verbatim cases are reproduced:
 *  1. The validation matrix (3 invalid package products → 422 with the exact
 *     codes DECIMAL_SCALE_INVALID / HOURS_MUST_BE_POSITIVE / VALID_DAYS_INVALID).
 *  2. Archived catalog records are hidden from the mini program.
 *
 * Plus: valid course + package creation, archive then 404 on mini detail,
 * archived package hidden in mini course detail, admin list includes archived
 * (admin sees all; mini sees only active).
 */
describe('Course and package catalog (e2e)', () => {
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
    await truncateCatalogTables(db);
    await seedAdmin({ db, username: TEST_USERNAME, password: TEST_PASSWORD });
  });

  afterEach(async () => {
    if (ctx && db) await truncateCatalogTables(db);
  });

  async function truncateCatalogTables(client: PrismaClient): Promise<void> {
    await client.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`package_product\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`course\``);
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

  // ── Catalog helpers (mirror the brief's verbatim helper names) ─────────

  async function createCourse(
    accessToken: string,
    body: { name: string; type: string; description: string } = {
      name: 'Guitar Class',
      type: 'CLASS',
      description: 'Beginner guitar',
    },
  ): Promise<{ id: string; name: string; type: string; status: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/admin/v1/courses')
      .set(adminAuth(accessToken))
      .send(body)
      .expect(201);
    return res.body;
  }

  async function archiveCourse(
    accessToken: string,
    id: string,
  ): Promise<{ id: string; status: string }> {
    const res = await request(app.getHttpServer())
      .post(`/api/admin/v1/courses/${id}/archive`)
      .set(adminAuth(accessToken))
      .expect(200);
    return res.body;
  }

  async function createPackage(
    accessToken: string,
    body: { price: string; hours: string; validDays: number; name?: string },
    expectStatus = 201,
    expectCode?: string,
    courseId?: string,
  ): Promise<{ id: string; courseId: string; price: string; hours: string; validDays: number }> {
    // If no courseId supplied, create a fresh course to attach the package to.
    const course =
      courseId !== undefined
        ? { id: courseId }
        : await createCourse(accessToken, {
            name: 'Package Host Course',
            type: 'ONE_TO_ONE',
            description: 'host',
          });
    const res = await request(app.getHttpServer())
      .post(`/api/admin/v1/courses/${course.id}/package-products`)
      .set(adminAuth(accessToken))
      .send({
        name: body.name ?? '10-Lesson Pack',
        price: body.price,
        hours: body.hours,
        validDays: body.validDays,
      })
      .expect(expectStatus);
    if (expectCode) {
      expect(res.body.code).toBe(expectCode);
    }
    return res.body;
  }

  /** Brief's verbatim `createPackage(adminToken, body, status, code)`. */
  async function createPackageVerbatim(
    accessToken: string,
    body: { price: string; hours: string; validDays: number },
    expectStatus: number,
    expectCode: string,
  ): Promise<void> {
    await createPackage(accessToken, body, expectStatus, expectCode);
  }

  async function listPublicCourses(
    accessToken: string,
  ): Promise<Array<{ id: string; name: string; status: string }>> {
    const res = await request(app.getHttpServer())
      .get('/api/mini/v1/courses')
      .set(memberAuth(accessToken))
      .expect(200);
    // Mini list items are CourseWithPackagesView ({course, packages}); flatten
    // to the course view so the archive-hide assertion checks course ids.
    const items = (res.body.items ?? res.body) as Array<{
      course?: { id: string; name: string; status: string };
      id?: string;
      name?: string;
      status?: string;
    }>;
    return items.map((c) =>
      c.course ? c.course : { id: c.id!, name: c.name!, status: c.status! },
    );
  }

  // ── The brief verbatim validation matrix ──────────────────────────────

  it.each([
    [{ price: '100.001', hours: '10.00', validDays: 30 }, 'DECIMAL_SCALE_INVALID'],
    [{ price: '100.00', hours: '0.00', validDays: 30 }, 'HOURS_MUST_BE_POSITIVE'],
    [{ price: '100.00', hours: '10.00', validDays: 0 }, 'VALID_DAYS_INVALID'],
  ])('rejects an invalid package product', async (body, code) => {
    if (!ctx) return;
    const admin = await adminLogin();
    await createPackageVerbatim(admin.accessToken, body, 422, code);
  });

  it('hides archived catalog records from the mini program', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const member = await boundMember('openid-catalog-hide', '13800000400');
    const course = await createCourse(admin.accessToken);
    await archiveCourse(admin.accessToken, course.id);
    const publicCourses = await listPublicCourses(member.accessToken);
    expect(publicCourses).not.toContainEqual(expect.objectContaining({ id: course.id }));
  });

  // ── Valid creation + archive lifecycle ────────────────────────────────

  it('admin creates a course and a valid package product', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const course = await createCourse(admin.accessToken, {
      name: 'Piano Class',
      type: 'CLASS',
      description: 'Group piano',
    });
    expect(course.id).toEqual(expect.any(String));
    expect(course.status).toBe('ACTIVE');

    const pkg = await createPackage(
      admin.accessToken,
      { price: '100.00', hours: '10.00', validDays: 30 },
      201,
      undefined,
      course.id,
    );
    expect(pkg.price).toBe('100.00');
    expect(pkg.hours).toBe('10.00');
    expect(pkg.validDays).toBe(30);
    expect(pkg.courseId).toBe(course.id);
  });

  it('accepts whole-number and single-decimal prices/hours', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const course = await createCourse(admin.accessToken);
    const a = await createPackage(
      admin.accessToken,
      { price: '100', hours: '5', validDays: 15 },
      201,
      undefined,
      course.id,
    );
    expect(a.price).toBe('100.00');
    expect(a.hours).toBe('5.00');
    const b = await createPackage(
      admin.accessToken,
      { price: '99.9', hours: '1.5', validDays: 10, name: 'Single dp' },
      201,
      undefined,
      course.id,
    );
    expect(b.price).toBe('99.90');
    expect(b.hours).toBe('1.50');
  });

  it('rejects an invalid course type with 400', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    await request(app.getHttpServer())
      .post('/api/admin/v1/courses')
      .set(adminAuth(admin.accessToken))
      .send({ name: 'Bad', type: 'WORKSHOP', description: 'x' })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_FAILED'));
  });

  it('admin updates a course name', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const course = await createCourse(admin.accessToken);
    const res = await request(app.getHttpServer())
      .patch(`/api/admin/v1/courses/${course.id}`)
      .set(adminAuth(admin.accessToken))
      .send({ name: 'Renamed Course' })
      .expect(200);
    expect(res.body.name).toBe('Renamed Course');
  });

  it('admin updates a package product price with validation', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const course = await createCourse(admin.accessToken);
    const pkg = await createPackage(
      admin.accessToken,
      { price: '100.00', hours: '10.00', validDays: 30 },
      201,
      undefined,
      course.id,
    );
    const res = await request(app.getHttpServer())
      .patch(`/api/admin/v1/package-products/${pkg.id}`)
      .set(adminAuth(admin.accessToken))
      .send({ price: '120.50' })
      .expect(200);
    expect(res.body.price).toBe('120.50');
    // Invalid scale on update → 422.
    await request(app.getHttpServer())
      .patch(`/api/admin/v1/package-products/${pkg.id}`)
      .set(adminAuth(admin.accessToken))
      .send({ price: '120.500' })
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe('DECIMAL_SCALE_INVALID'));
  });

  it('archives a package product softly and never physically deletes it', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const course = await createCourse(admin.accessToken);
    const pkg = await createPackage(
      admin.accessToken,
      { price: '50.00', hours: '2.00', validDays: 7 },
      201,
      undefined,
      course.id,
    );
    const res = await request(app.getHttpServer())
      .post(`/api/admin/v1/package-products/${pkg.id}/archive`)
      .set(adminAuth(admin.accessToken))
      .expect(200);
    expect(res.body.status).toBe('ARCHIVED');
    // Row still physically exists.
    const stillThere = await db.packageProduct.findUnique({ where: { id: pkg.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.status).toBe('ARCHIVED');
  });

  it('archive is idempotent on an already-archived course', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const course = await createCourse(admin.accessToken);
    await archiveCourse(admin.accessToken, course.id);
    // Second archive returns the same ARCHIVED state (no error).
    const res = await request(app.getHttpServer())
      .post(`/api/admin/v1/courses/${course.id}/archive`)
      .set(adminAuth(admin.accessToken))
      .expect(200);
    expect(res.body.status).toBe('ARCHIVED');
  });

  it('admin list includes archived courses (admin sees all)', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const a = await createCourse(admin.accessToken, {
      name: 'Active One',
      type: 'CLASS',
      description: 'a',
    });
    const b = await createCourse(admin.accessToken, {
      name: 'Archived One',
      type: 'ONE_TO_ONE',
      description: 'b',
    });
    await archiveCourse(admin.accessToken, b.id);
    const res = await request(app.getHttpServer())
      .get('/api/admin/v1/courses')
      .set(adminAuth(admin.accessToken))
      .expect(200);
    const ids = res.body.items.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('admin list filters by status and type', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const a = await createCourse(admin.accessToken, {
      name: 'C1',
      type: 'CLASS',
      description: 'x',
    });
    const b = await createCourse(admin.accessToken, {
      name: 'C2',
      type: 'ONE_TO_ONE',
      description: 'x',
    });
    await archiveCourse(admin.accessToken, b.id);
    const active = await request(app.getHttpServer())
      .get('/api/admin/v1/courses?status=ACTIVE')
      .set(adminAuth(admin.accessToken))
      .expect(200);
    expect(active.body.items.map((c: { id: string }) => c.id)).toContain(a.id);
    expect(active.body.items.map((c: { id: string }) => c.id)).not.toContain(b.id);
    const oneToOne = await request(app.getHttpServer())
      .get('/api/admin/v1/courses?type=ONE_TO_ONE')
      .set(adminAuth(admin.accessToken))
      .expect(200);
    expect(oneToOne.body.items.map((c: { id: string }) => c.id)).toContain(b.id);
  });

  it('mini detail returns 404 for an archived course', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const member = await boundMember('openid-catalog-detail', '13800000401');
    const course = await createCourse(admin.accessToken);
    await archiveCourse(admin.accessToken, course.id);
    await request(app.getHttpServer())
      .get(`/api/mini/v1/courses/${course.id}`)
      .set(memberAuth(member.accessToken))
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('RESOURCE_NOT_FOUND'));
  });

  it('mini detail returns 404 for a missing course', async () => {
    if (!ctx) return;
    const member = await boundMember('openid-catalog-missing', '13800000402');
    await request(app.getHttpServer())
      .get('/api/mini/v1/courses/00000000-0000-0000-0000-000000000000')
      .set(memberAuth(member.accessToken))
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('RESOURCE_NOT_FOUND'));
  });

  it('mini detail hides archived packages inside an active course', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const member = await boundMember('openid-catalog-pkg', '13800000403');
    const course = await createCourse(admin.accessToken);
    const activePkg = await createPackage(
      admin.accessToken,
      { price: '100.00', hours: '10.00', validDays: 30, name: 'Active Pack' },
      201,
      undefined,
      course.id,
    );
    const archivedPkg = await createPackage(
      admin.accessToken,
      { price: '20.00', hours: '1.00', validDays: 5, name: 'Archived Pack' },
      201,
      undefined,
      course.id,
    );
    await request(app.getHttpServer())
      .post(`/api/admin/v1/package-products/${archivedPkg.id}/archive`)
      .set(adminAuth(admin.accessToken))
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/api/mini/v1/courses/${course.id}`)
      .set(memberAuth(member.accessToken))
      .expect(200);
    expect(res.body.course.id).toBe(course.id);
    const pkgIds = res.body.packages.map((p: { id: string }) => p.id);
    expect(pkgIds).toContain(activePkg.id);
    expect(pkgIds).not.toContain(archivedPkg.id);
  });

  it('mini list hides archived packages when returning courses (active packages only)', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const member = await boundMember('openid-catalog-list', '13800000404');
    const course = await createCourse(admin.accessToken);
    const archivedPkg = await createPackage(
      admin.accessToken,
      { price: '20.00', hours: '1.00', validDays: 5, name: 'Archived Pack' },
      201,
      undefined,
      course.id,
    );
    await request(app.getHttpServer())
      .post(`/api/admin/v1/package-products/${archivedPkg.id}/archive`)
      .set(adminAuth(admin.accessToken))
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/mini/v1/courses')
      .set(memberAuth(member.accessToken))
      .expect(200);
    // Mini list items are { course, packages } (CourseWithPackagesView).
    const found = (
      res.body.items as Array<{
        course: { id: string };
        packages?: Array<{ id: string }>;
      }>
    ).find((c) => c.course.id === course.id);
    expect(found).toBeDefined();
    // No archived packages leak through the mini list.
    const leakedArchived = (found?.packages ?? []).some((p) => p.id === archivedPkg.id);
    expect(leakedArchived).toBe(false);
  });

  it('mini catalog routes require a bound member (403 while provisional)', async () => {
    if (!ctx) return;
    const code = loginCodeFor('openid-catalog-provisional');
    fakeWechat.setSession(code, { openId: 'openid-catalog-provisional' });
    const login = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/wechat-login')
      .send({ code })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/mini/v1/courses')
      .set(memberAuth(login.body.accessToken))
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('STUDENT_FORBIDDEN'));
  });

  it('admin catalog routes reject a member token', async () => {
    if (!ctx) return;
    const member = await boundMember('openid-catalog-admin-reject', '13800000405');
    const res = await request(app.getHttpServer())
      .get('/api/admin/v1/courses')
      .set(memberAuth(member.accessToken));
    expect([401, 403]).toContain(res.status);
  });

  it('creating a package under a missing course returns 404', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    await request(app.getHttpServer())
      .post('/api/admin/v1/courses/00000000-0000-0000-0000-000000000000/package-products')
      .set(adminAuth(admin.accessToken))
      .send({ name: 'Pack', price: '10.00', hours: '1.00', validDays: 5 })
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('RESOURCE_NOT_FOUND'));
  });
});
