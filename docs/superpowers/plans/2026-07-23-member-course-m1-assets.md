# M1 Member and Lesson-Hour Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first testable product increment: member/student onboarding, course/package catalog, offline order confirmation, lesson-hour accounting, manual adjustments, and member asset queries in the admin web app and WeChat mini program.

**Architecture:** Start a pnpm monorepo with one modular NestJS application, one Vue 3 admin app, one native WeChat mini program, and a framework-free contracts package. MySQL is the source of truth; all money and lesson-hour arithmetic uses `Prisma.Decimal` and append-only postings. M1 deliberately excludes scheduling, booking, attendance, activities, notifications, production audit, and account deletion.

**Tech Stack:** Node.js 22 LTS, pnpm 10, TypeScript 5, NestJS 11, Prisma 6, MySQL 8.4, Vue 3, Vite, Pinia, Element Plus, WeChat native TypeScript, Vitest, Supertest, Testcontainers, Playwright.

## Global Constraints

- Repository: `https://github.com/Broccoli-X/member-course-miniapp.git`.
- Product scope is one institution, one campus, 2C only; do not add tenant or campus IDs.
- API prefixes are exactly `/api/admin/v1` and `/api/mini/v1`.
- Store timestamps in UTC; calculate business dates and display values in `Asia/Shanghai`.
- Store money and lesson hours as `DECIMAL(10,2)`; HTTP contracts carry decimal values as strings; never calculate them with JavaScript `number`.
- A member account can manage self and multiple children; every order item and lesson-hour asset belongs to one student.
- WeChat login plus verified phone binding is required before private asset access.
- Offline orders are recorded by administrators; there is no mini-program order creation, online payment, or refund.
- Lesson hours are isolated by student and course. Balance changes only through append-only transactions and allocations.
- No Redis, message queue, microservice, teacher portal, activity module, or placeholder UI for later milestones.
- Use TDD, real MySQL integration tests for transactions/concurrency, exact business error codes, and one focused commit per task.

---

## Locked File Structure

~~~text
apps/
  api/
    prisma/schema.prisma
    prisma/migrations/
    src/common/
    src/infrastructure/prisma/
    src/modules/identity/
    src/modules/catalog/
    src/modules/hours/
    src/modules/orders/
    test/integration/
    test/e2e/
  admin-web/
    src/api/
    src/features/
    src/layouts/
    src/router/
    src/stores/
    e2e/
  miniapp/
    miniprogram/components/
    miniprogram/pages/
    miniprogram/services/
    miniprogram/stores/
    tests/
packages/
  contracts/src/
~~~

Package names are fixed as `@member-course/api`, `@member-course/admin-web`, `@member-course/miniapp`, and `@member-course/contracts`.

Core interfaces produced by M1:

~~~ts
export type DecimalString = string;

export interface CommandContext {
  actorType: 'ADMIN' | 'MEMBER' | 'SYSTEM';
  actorId: string;
  requestId: string;
  idempotencyKey: string;
}

export interface HourPostingResult {
  transactionId: string;
  balanceId: string;
  allocations: Array<{
    packageId: string;
    packageExpiresOn: string;
    units: DecimalString;
    availableDelta: DecimalString;
    reservedDelta: DecimalString;
    consumedDelta: DecimalString;
    expiredDelta: DecimalString;
  }>;
  balance: {
    available: DecimalString;
    reserved: DecimalString;
    consumed: DecimalString;
    expired: DecimalString;
  };
}
~~~

### Task 1: Bootstrap the Monorepo and Three Runnable Applications

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `pnpm-lock.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `compose.yaml`
- Create: `apps/api/package.json`
- Create: `apps/api/nest-cli.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/tsconfig.build.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/health.controller.ts`
- Test: `apps/api/src/health.controller.spec.ts`
- Create: `apps/admin-web/package.json`
- Create: `apps/admin-web/index.html`
- Create: `apps/admin-web/tsconfig.json`
- Create: `apps/admin-web/vite.config.ts`
- Create: `apps/admin-web/vitest.config.ts`
- Create: `apps/admin-web/src/main.ts`
- Create: `apps/admin-web/src/App.vue`
- Test: `apps/admin-web/src/App.spec.ts`
- Create: `apps/miniapp/package.json`
- Create: `apps/miniapp/project.config.json`
- Create: `apps/miniapp/tsconfig.json`
- Create: `apps/miniapp/vitest.config.ts`
- Create: `apps/miniapp/miniprogram/app.ts`
- Create: `apps/miniapp/miniprogram/app.json`
- Create: `apps/miniapp/miniprogram/app.wxss`
- Create: `apps/miniapp/miniprogram/sitemap.json`
- Create: `apps/miniapp/miniprogram/pages/courses/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/my/index.{ts,json,wxml,wxss}`
- Test: `apps/miniapp/tests/bootstrap.spec.ts`
- Test: `apps/miniapp/tests/pages/courses-empty-state.spec.ts`
- Test: `apps/miniapp/tests/pages/my-empty-state.spec.ts`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: Approved design only.
- Produces: workspace scripts `lint`, `typecheck`, `test`, and `build`; API `GET /health` returning `{"status":"ok"}`; three independently testable packages.

- [ ] **Step 1: Create root workspace configuration**

~~~json
{
  "name": "member-course-miniapp",
  "private": true,
  "packageManager": "pnpm@10.13.1",
  "engines": { "node": ">=22.14.0 <23" },
  "scripts": {
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  }
}
~~~

~~~yaml
packages:
  - apps/*
  - packages/*
~~~

Create `compose.yaml` with MySQL `8.4`, database `member_course`, health check `mysqladmin ping`, and host port `3307`. Put only development defaults in `.env.example`; do not commit real passwords or WeChat secrets.

Use these package scripts so every later command is defined:

~~~text
@member-course/api: lint, typecheck, test, test:integration, test:e2e, build,
                    prisma, prisma:generate, prisma:validate
@member-course/admin-web: lint, typecheck, test, test:e2e, build
@member-course/miniapp: lint, typecheck, test, build
@member-course/contracts: lint, typecheck, test, build
~~~

- [ ] **Step 2: Install pinned major-version dependencies**

Run:

~~~bash
pnpm add -Dw typescript@^5 @types/node eslint@^9 prettier@^3 vitest@^3
pnpm --dir apps/api add @nestjs/common@^11 @nestjs/core@^11 @nestjs/platform-express@^11 reflect-metadata rxjs
pnpm --dir apps/api add -D @nestjs/testing@^11 supertest @types/supertest
pnpm --dir apps/admin-web add vue@^3 pinia@^3 vue-router@^4 element-plus
pnpm --dir apps/admin-web add -D vite vue-tsc @vitejs/plugin-vue @vue/test-utils jsdom
pnpm --dir apps/miniapp add -D miniprogram-api-typings miniprogram-simulate
~~~

Expected: `pnpm-lock.yaml` is created and all four workspace packages resolve.

- [ ] **Step 3: Write the failing smoke and initial-page tests**

~~~ts
// apps/api/src/health.controller.spec.ts
it('returns API health', () => {
  expect(new HealthController().getHealth()).toEqual({ status: 'ok' });
});

// apps/admin-web/src/App.spec.ts
it('renders the application shell', () => {
  expect(mount(App).get('[data-testid="app-shell"]').exists()).toBe(true);
});

// apps/miniapp/tests/bootstrap.spec.ts
import { readFileSync } from 'node:fs';

it('declares the initial course and profile pages', () => {
  const config = JSON.parse(
    readFileSync(new URL('../miniprogram/app.json', import.meta.url), 'utf8'),
  ) as { pages: string[] };
  expect(config.pages).toEqual(['pages/courses/index', 'pages/my/index']);
});
~~~

Use `miniprogram-simulate` in `courses-empty-state.spec.ts` and `my-empty-state.spec.ts` to mount each page and assert its visible empty-state copy. The bootstrap test only owns `app.json`; it does not substitute for page rendering tests.

- [ ] **Step 4: Run the tests and verify they fail**

Run: `pnpm test`

Expected: FAIL because `HealthController`, the app shell, and the two mini-program pages do not exist.

- [ ] **Step 5: Add the minimal application bootstraps**

~~~ts
// apps/api/src/health.controller.ts
@Controller('health')
export class HealthController {
  @Get()
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

// apps/api/src/main.ts
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();
~~~

~~~vue
<!-- apps/admin-web/src/App.vue -->
<template><main data-testid="app-shell"><RouterView /></main></template>
~~~

Create native mini-program `pages/courses/index` and `pages/my/index` with real empty states: “暂无已上架课程” and “绑定手机号后查看会员资产”. Do not create schedule or activity placeholders.

- [ ] **Step 6: Verify the workspace**

Run:

~~~bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
~~~

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

~~~bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.mjs .prettierrc.json .editorconfig .gitignore .env.example compose.yaml apps packages
git commit -m "chore: scaffold member course monorepo"
~~~

### Task 2: Add the M1 Prisma Schema and MySQL Test Harness

**Files:**
- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/202607230001_m1_core/migration.sql`
- Create: `apps/api/prisma/migrations/migration_lock.toml`
- Create: `apps/api/src/infrastructure/prisma/prisma.service.ts`
- Create: `apps/api/src/infrastructure/prisma/prisma.module.ts`
- Create: `apps/api/test/helpers/mysql-test-environment.ts`
- Create: `apps/api/test/helpers/m1-schema-fixtures.ts`
- Test: `apps/api/test/integration/prisma/m1-schema.integration-spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 NestJS app.
- Produces: `PrismaService`; M1 tables for `AdminUser`, `MemberAccount`, `WechatIdentity`, `RefreshSession`, `StudentProfile`, `AccountStudentRelation`, `Course`, `PackageProduct`, `OfflineOrder`, `OrderItem`, `CoursePackage`, `StudentCourseBalance`, `HourTransaction`, `HourAllocation`, and `IdempotencyRecord`.

- [ ] **Step 1: Write the failing schema integration test**

~~~ts
it('enforces M1 ownership and idempotency constraints', async () => {
  await seedMemberStudentCourse(db);
  await expect(createDuplicateBalance(db)).rejects.toMatchObject({ code: 'P2002' });
  await expect(createDuplicateAccountStudentRelation(db)).rejects.toMatchObject({ code: 'P2002' });
  await expect(createDuplicateIdempotencyKey(db)).rejects.toMatchObject({ code: 'P2002' });
});

it('prevents deleting referenced catalog and member records', async () => {
  const fixture = await seedConfirmedOrderFixture(db);
  await expect(db.course.delete({ where: { id: fixture.courseId } })).rejects.toBeDefined();
  await expect(db.studentProfile.delete({ where: { id: fixture.studentId } })).rejects.toBeDefined();
});
~~~

- [ ] **Step 2: Run the integration test and verify failure**

Run: `pnpm --filter @member-course/api test:integration -- test/integration/prisma/m1-schema.integration-spec.ts`

Expected: FAIL because Prisma and the M1 tables do not exist.

- [ ] **Step 3: Define the exact model invariants**

Implement the models with these non-negotiable fields and indexes:

~~~text
AdminUser: id, username(unique), passwordHash, status, failedLoginCount, lockedUntil,
           createdAt, updatedAt, version
MemberAccount: id, normalizedPhone(unique nullable), status, isProvisional, createdAt, updatedAt, version
WechatIdentity: id, accountId, openId(unique), unionId(nullable indexed), createdAt, updatedAt, version
RefreshSession: id, adminUserId xor memberAccountId, tokenHash, expiresAt, revokedAt,
                createdAt, updatedAt, version
StudentProfile: id, displayName, birthDate(nullable), status, createdAt, updatedAt, version
AccountStudentRelation: accountId + studentId(unique), relationType, verifiedByAdminId(nullable),
                        createdAt, updatedAt, version
Course: id, name, type(CLASS|ONE_TO_ONE), description, status, createdAt, updatedAt, version
PackageProduct: id, courseId, name, price Decimal(10,2), hours Decimal(10,2), validDays,
                status, createdAt, updatedAt, version
OfflineOrder: id, buyerAccountId, status, totalAmount Decimal(10,2), confirmedAt,
              createdAt, updatedAt, version
OrderItem: id, orderId, studentId, productId, courseId, productNameSnapshot,
           unitPriceSnapshot Decimal(10,2), hoursSnapshot Decimal(10,2), validDaysSnapshot,
           createdAt, updatedAt, version
CoursePackage: id, studentId, courseId, sourceType, sourceOrderItemId(unique nullable),
               startsOn, expiresOn, granted, available, reserved, consumed, expired, status,
               createdAt, updatedAt, version
StudentCourseBalance: studentId + courseId(unique), available, reserved, consumed, expired,
                      createdAt, updatedAt, version
HourTransaction: id, studentId, courseId, type, businessKey(unique), four bucket deltas,
                 occurredAt, createdAt
HourAllocation: id, transactionId, packageId, sourceType, sourceId, four bucket deltas, createdAt
IdempotencyRecord: scope + actorId + key(unique), requestHash, state, responseStatus, responseBody,
                   createdAt, updatedAt, version
~~~

Use `Restrict` for referenced business foreign keys. Add CHECK constraints for non-negative package/balance buckets and “refresh session belongs to exactly one actor”.

- [ ] **Step 4: Add Prisma infrastructure and Testcontainers**

Install the pinned major-version persistence dependencies:

~~~bash
pnpm --dir apps/api add @prisma/client@^6
pnpm --dir apps/api add -D prisma@^6 @testcontainers/mysql
~~~

~~~ts
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
~~~

The test environment must start `mysql:8.4`, set `DATABASE_URL`, run `prisma migrate deploy`, and clean tables between tests without replacing MySQL with SQLite.

- [ ] **Step 5: Validate and rerun**

Run:

~~~bash
pnpm --filter @member-course/api prisma validate
pnpm --filter @member-course/api prisma generate
pnpm --filter @member-course/api test:integration -- test/integration/prisma/m1-schema.integration-spec.ts
~~~

Expected: schema validation passes and both integration tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add apps/api/prisma apps/api/src/infrastructure apps/api/test apps/api/src/app.module.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add m1 persistence schema"
~~~

### Task 3: Add Error, Trace, Business-Date, and Idempotency Infrastructure

**Files:**
- Create: `packages/contracts/src/common.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/pagination.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/common/errors/business-error.ts`
- Create: `apps/api/src/common/errors/business-error.filter.ts`
- Create: `apps/api/src/common/http/trace-id.middleware.ts`
- Create: `apps/api/src/common/http/pagination.dto.ts`
- Test: `apps/api/src/common/http/pagination.dto.spec.ts`
- Create: `apps/api/src/common/time/business-date.ts`
- Create: `apps/api/src/common/idempotency/idempotency.service.ts`
- Test: `apps/api/src/common/idempotency/idempotency.service.spec.ts`
- Test: `apps/api/test/integration/idempotency.integration-spec.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `PrismaService` from Task 2.
- Produces: `BusinessError`, response shape `{code,message,traceId,details}`, shared `page/pageSize/sort` contracts, validated `PaginationDto`, `calculateExpiryDate(confirmedAt, validDays)`, and `IdempotencyService.execute<T>()`.

- [ ] **Step 1: Write failing date and idempotency tests**

~~~ts
it('includes both confirmation and expiry dates in Shanghai', () => {
  expect(calculateExpiryDate(new Date('2026-07-23T15:59:59Z'), 30)).toBe('2026-08-22');
});

it('executes one transaction for concurrent identical requests', async () => {
  const work = vi.fn(async () => ({ orderId: 'order-1' }));
  const [first, second] = await Promise.all([
    service.execute(request, work),
    service.execute(request, work),
  ]);
  expect(first).toEqual(second);
  expect(work).toHaveBeenCalledTimes(1);
});

it('rejects key reuse with a different body hash', async () => {
  await service.execute(request, work);
  await expect(service.execute({ ...request, requestHash: 'other' }, work))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 409 });
});

it('rejects pagination values outside the fixed contract', () => {
  expect(() => validatePagination({ page: 0, pageSize: 101, sort: 'unknown' }))
    .toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/common
pnpm --filter @member-course/api test:integration -- test/integration/idempotency.integration-spec.ts
~~~

Expected: FAIL with missing `calculateExpiryDate` and `IdempotencyService`.

- [ ] **Step 3: Implement the fixed interfaces**

Install request validation dependencies before implementing the DTO:

~~~bash
pnpm --dir apps/api add class-validator class-transformer
~~~

~~~ts
export interface IdempotentRequest {
  scope: string;
  actorId: string;
  key: string;
  requestHash: string;
}

execute<T>(
  request: IdempotentRequest,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T>;
~~~

Persist `IN_PROGRESS` before work, save the serialized successful response in the same transaction, return the saved response for the same hash, and reject a different hash. Map Prisma `P2002` to 409 `STATE_CHANGED`, `P2025` to 404 `RESOURCE_NOT_FOUND`, DTO validation to 400 `VALIDATION_FAILED`, and unhandled failures to 500 `INTERNAL_ERROR`; never leak stack traces in HTTP responses.

- [ ] **Step 4: Rerun target tests**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/common
pnpm --filter @member-course/api test:integration -- test/integration/idempotency.integration-spec.ts
~~~

Expected: all target tests pass; identical concurrent calls return byte-equivalent bodies.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts apps/api/src/common apps/api/test/integration/idempotency.integration-spec.ts apps/api/src/main.ts apps/api/src/app.module.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add request and idempotency infrastructure"
~~~

### Task 4: Implement Administrator Authentication

**Files:**
- Create: `packages/contracts/src/auth.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/modules/identity/application/admin-auth.service.ts`
- Create: `apps/api/src/modules/identity/domain/password-hasher.ts`
- Create: `apps/api/src/modules/identity/infrastructure/argon2-password-hasher.ts`
- Create: `apps/api/src/modules/identity/infrastructure/jwt-token.service.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/admin-auth.controller.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/admin-auth.guard.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/dto/admin-login.dto.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/dto/admin-refresh.dto.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/dto/admin-logout.dto.ts`
- Create: `apps/api/src/modules/identity/identity.module.ts`
- Create: `apps/api/prisma/seed.ts`
- Test: `apps/api/test/e2e/admin-auth.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 2 refresh sessions and Task 3 errors.
- Produces: `POST /api/admin/v1/auth/login`, `POST /api/admin/v1/auth/refresh`, `POST /api/admin/v1/auth/logout`, and `AdminPrincipal`.

- [ ] **Step 1: Write the failing auth journey**

~~~ts
it('locks an administrator for 15 minutes after five failures', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await request(app).post('/api/admin/v1/auth/login').send(badCredentials).expect(401);
  }
  await request(app).post('/api/admin/v1/auth/login').send(validCredentials)
    .expect(429)
    .expect(({ body }) => expect(body.code).toBe('ADMIN_LOGIN_LOCKED'));
});

it('rotates refresh tokens and rejects the replaced token', async () => {
  const login = await loginAsAdmin(app);
  const refreshed = await refreshAdmin(app, login.refreshToken);
  expect(refreshed.refreshToken).not.toBe(login.refreshToken);
  await refreshAdmin(app, login.refreshToken, 401);
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test:e2e -- test/e2e/admin-auth.e2e-spec.ts`

Expected: FAIL with 404 for the auth endpoints.

- [ ] **Step 3: Implement fixed security parameters**

Install the authentication dependencies:

~~~bash
pnpm --dir apps/api add @nestjs/jwt argon2
~~~

Use Argon2id. Lock after 5 consecutive failures for 15 minutes. Access token lifetime is 15 minutes. Refresh token lifetime is 30 days and rotates on each use; store only its hash. Seed the first administrator from `ADMIN_SEED_USERNAME` and `ADMIN_SEED_PASSWORD`, failing fast if either is absent outside tests.

- [ ] **Step 4: Rerun and pass**

Run: `pnpm --filter @member-course/api test:e2e -- test/e2e/admin-auth.e2e-spec.ts`

Expected: login, lockout, refresh rotation, logout, and disabled-admin cases all pass.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts/src/auth.ts packages/contracts/src/index.ts apps/api/src/modules/identity apps/api/prisma/seed.ts apps/api/test/e2e/admin-auth.e2e-spec.ts apps/api/src/app.module.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add administrator authentication"
~~~

### Task 5: Implement WeChat Login and Atomic Phone Binding

**Files:**
- Create: `apps/api/src/modules/identity/domain/wechat-gateway.ts`
- Create: `apps/api/src/modules/identity/application/wechat-auth.service.ts`
- Create: `apps/api/src/modules/identity/application/phone-binding.service.ts`
- Create: `apps/api/src/modules/identity/infrastructure/wechat-http.gateway.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/mini-auth.controller.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/mini-auth.guard.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/bound-member.guard.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/dto/wechat-login.dto.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/dto/bind-wechat-phone.dto.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/dto/mini-refresh.dto.ts`
- Modify: `apps/api/src/modules/identity/identity.module.ts`
- Modify: `packages/contracts/src/auth.ts`
- Create: `apps/api/test/helpers/identity-fixtures.ts`
- Create: `apps/api/test/doubles/fake-wechat.gateway.ts`
- Test: `apps/api/test/integration/phone-binding.integration-spec.ts`
- Test: `apps/api/test/e2e/mini-auth.e2e-spec.ts`

**Interfaces:**
- Consumes: refresh-token infrastructure.
- Produces: `WechatGateway.exchangeCode`, `WechatGateway.exchangePhoneCode`, `WechatAuthService.login`, and `PhoneBindingService.bind`.

- [ ] **Step 1: Write the failing merge tests**

~~~ts
it('moves a provisional WeChat identity to one pre-created phone account', async () => {
  const provisional = await loginWithWechat(fakeWechat, 'openid-1');
  const precreated = await createPrecreatedMember(db, '13800000000');
  const result = await bindPhone(provisional, 'phone-code-1');
  expect(result.accountId).toBe(precreated.id);
  expect(await accountStatus(db, provisional.accountId)).toBe('DISABLED');
  expect(await identityOwner(db, 'openid-1')).toBe(precreated.id);
});

it('rolls back when the pre-created phone account owns another WeChat identity', async () => {
  const provisional = await loginWithWechat(fakeWechat, 'openid-1');
  const precreated = await createPrecreatedMember(db, '13800000000');
  await attachWechatIdentity(precreated.id, 'openid-existing');
  await expect(bindPhone(provisional, 'phone-code-1'))
    .rejects.toMatchObject({ code: 'PHONE_BINDING_CONFLICT' });
  expect(await identityOwner(db, 'openid-1')).toBe(provisional.accountId);
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test:integration -- test/integration/phone-binding.integration-spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/mini-auth.e2e-spec.ts
~~~

Expected: both files fail because mini auth does not exist.

- [ ] **Step 3: Implement the four endpoints**

~~~text
POST /api/mini/v1/auth/wechat-login
POST /api/mini/v1/auth/bind-phone
POST /api/mini/v1/auth/refresh
POST /api/mini/v1/auth/logout
~~~

Unbound provisional accounts may access only public catalog and auth endpoints. Normalize the verified phone before lookup and lock the matching `MemberAccount.normalizedPhone` row during binding. Never merge by name. If exactly one pre-created account exists and does not already own another WeChat identity, move the identity in one transaction; otherwise return `PHONE_BINDING_CONFLICT`.

- [ ] **Step 4: Rerun and pass**

Run:

~~~bash
pnpm --filter @member-course/api test:integration -- test/integration/phone-binding.integration-spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/mini-auth.e2e-spec.ts
~~~

Expected: provisional login, new-phone binding, pre-created-account migration, conflict rollback, and repeated-code protection pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/identity packages/contracts/src/auth.ts apps/api/test
git commit -m "feat(api): add wechat login and phone binding"
~~~

### Task 6: Implement Member, Student, and Guardian Relations

**Files:**
- Create: `packages/contracts/src/member.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/modules/identity/application/member-admin.service.ts`
- Create: `apps/api/src/modules/identity/application/member-admin-query.service.ts`
- Create: `apps/api/src/modules/identity/application/student-profile.service.ts`
- Create: `apps/api/src/modules/identity/application/account-student-relation.service.ts`
- Create: `apps/api/src/modules/identity/application/student-access.service.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/member-admin.controller.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/member-mini.controller.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/dto/member-admin.dto.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/dto/student-profile.dto.ts`
- Modify: `apps/api/src/modules/identity/identity.module.ts`
- Test: `apps/api/test/e2e/member-student.e2e-spec.ts`

**Interfaces:**
- Produces: member/student CRUD, `StudentAccessService.assertRelated(accountId, studentId)`, and administrator-only secondary guardian linking.

- [ ] **Step 1: Write the failing authorization tests**

~~~ts
it('lets a bound account create self and child profiles', async () => {
  const self = await createStudent(memberToken, { relationship: 'SELF', displayName: 'Chen' });
  const child = await createStudent(memberToken, { relationship: 'GUARDIAN', displayName: 'Xiao Chen' });
  expect([self.relationship, child.relationship]).toEqual(['SELF', 'GUARDIAN']);
});

it('forbids self-service secondary guardian links', async () => {
  await request(app).post('/api/mini/v1/students/' + student.id + '/relations')
    .set(memberAuth)
    .send({ accountId: other.id })
    .expect(403);
});

it('does not reveal an unrelated student', async () => {
  await request(app).get('/api/mini/v1/students/' + unrelated.id)
    .set(memberAuth)
    .expect(403)
    .expect(({ body }) => expect(body.code).toBe('STUDENT_FORBIDDEN'));
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test:e2e -- test/e2e/member-student.e2e-spec.ts`

Expected: FAIL with missing routes.

- [ ] **Step 3: Implement the exact endpoints**

~~~text
GET     /api/admin/v1/members
POST    /api/admin/v1/members
GET     /api/admin/v1/members/:id
POST    /api/admin/v1/members/:id/students
PATCH   /api/admin/v1/students/:studentId
POST    /api/admin/v1/students/:studentId/relations
DELETE  /api/admin/v1/students/:studentId/relations/:accountId
GET     /api/mini/v1/me
GET     /api/mini/v1/students
POST    /api/mini/v1/students
GET     /api/mini/v1/students/:studentId
PATCH   /api/mini/v1/students/:studentId
~~~

Allow only administrators to add or remove a second guardian after recording `verifiedByAdminId`. Enforce one active `SELF` profile per member. Do not auto-merge students based on matching profile data.

- [ ] **Step 4: Rerun and pass**

Run: `pnpm --filter @member-course/api test:e2e -- test/e2e/member-student.e2e-spec.ts`

Expected: all member, child, guardian, and unrelated-access cases pass.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts/src/member.ts packages/contracts/src/index.ts apps/api/src/modules/identity apps/api/test/e2e/member-student.e2e-spec.ts
git commit -m "feat(api): add member and student management"
~~~

### Task 7: Implement Course and Package Catalog

**Files:**
- Create: `packages/contracts/src/catalog.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/modules/catalog/application/catalog-command.service.ts`
- Create: `apps/api/src/modules/catalog/application/catalog-query.service.ts`
- Create: `apps/api/src/modules/catalog/presentation/admin/catalog-admin.controller.ts`
- Create: `apps/api/src/modules/catalog/presentation/mini/catalog-mini.controller.ts`
- Create: `apps/api/src/modules/catalog/presentation/admin/dto/catalog.dto.ts`
- Create: `apps/api/src/modules/catalog/catalog.module.ts`
- Test: `apps/api/test/e2e/catalog.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: administrator catalog CRUD and public mini-program catalog reads. M1 includes `CLASS` and `ONE_TO_ONE` type only; policy versions start in M2.

- [ ] **Step 1: Write failing validation and archive tests**

~~~ts
it.each([
  [{ price: '100.001', hours: '10.00', validDays: 30 }, 'DECIMAL_SCALE_INVALID'],
  [{ price: '100.00', hours: '0.00', validDays: 30 }, 'HOURS_MUST_BE_POSITIVE'],
  [{ price: '100.00', hours: '10.00', validDays: 0 }, 'VALID_DAYS_INVALID'],
])('rejects an invalid package product', async (body, code) => {
  await createPackage(adminToken, body, 422, code);
});

it('hides archived catalog records from the mini program', async () => {
  const course = await createCourse(adminToken);
  await archiveCourse(adminToken, course.id);
  expect(await listPublicCourses()).not.toContainEqual(expect.objectContaining({ id: course.id }));
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test:e2e -- test/e2e/catalog.e2e-spec.ts`

Expected: FAIL because catalog routes are missing.

- [ ] **Step 3: Implement exact routes**

~~~text
GET    /api/admin/v1/courses
POST   /api/admin/v1/courses
PATCH  /api/admin/v1/courses/:id
POST   /api/admin/v1/courses/:id/archive
POST   /api/admin/v1/courses/:courseId/package-products
PATCH  /api/admin/v1/package-products/:id
POST   /api/admin/v1/package-products/:id/archive
GET    /api/mini/v1/courses
GET    /api/mini/v1/courses/:id
~~~

Parse decimal strings with `Prisma.Decimal` and reject more than two decimal places. Referenced records are archived, never physically deleted.

- [ ] **Step 4: Run target tests**

Run: `pnpm --filter @member-course/api test:e2e -- test/e2e/catalog.e2e-spec.ts`

Expected: validation, public filtering, and history-preserving archive cases pass.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts/src/catalog.ts packages/contracts/src/index.ts apps/api/src/modules/catalog apps/api/test/e2e/catalog.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): add course and package catalog"
~~~

### Task 8: Implement the Append-Only Lesson-Hour Ledger

**Files:**
- Create: `packages/contracts/src/hours.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/modules/hours/domain/hour-buckets.ts`
- Create: `apps/api/src/modules/hours/domain/hour-allocation-policy.ts`
- Test: `apps/api/src/modules/hours/domain/hour-allocation-policy.spec.ts`
- Create: `apps/api/src/modules/hours/application/hour-ledger.service.ts`
- Create: `apps/api/src/modules/hours/infrastructure/hour-lock.repository.ts`
- Create: `apps/api/src/modules/hours/hours.module.ts`
- Test: `apps/api/test/integration/hour-ledger.integration-spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: Prisma transactions and the M1 persistence schema.
- Produces:

~~~ts
export interface GrantOrderHoursInput {
  orderId: string;
  orderItemId: string;
  studentId: string;
  courseId: string;
  packageId: string;
  units: DecimalString;
  occurredAt: Date;
  businessKey: string;
}

export interface ReverseOrderHoursInput {
  orderId: string;
  orderItemId: string;
  originalTransactionId: string;
  occurredAt: Date;
  businessKey: string;
  reason: string;
}

grantOrder(tx: Prisma.TransactionClient, input: GrantOrderHoursInput): Promise<HourPostingResult>;
reverseOrder(tx: Prisma.TransactionClient, input: ReverseOrderHoursInput): Promise<HourPostingResult>;
~~~

- [ ] **Step 1: Write failing FEFO and order-posting tests**

~~~ts
it('allocates by expiresOn, createdAt, and id', () => {
  const allocation = allocate(new Decimal('5.00'), [
    pkg('b', '2026-08-31', '2026-07-02', '3.00'),
    pkg('a', '2026-08-31', '2026-07-01', '2.00'),
    pkg('c', '2026-09-30', '2026-07-01', '5.00'),
  ]);
  expect(allocation).toEqual([{ packageId: 'a', units: '2.00' }, { packageId: 'b', units: '3.00' }]);
});

it('posts one order grant and keeps the balance reconcilable', async () => {
  const result = await grantOrder(tx, orderGrantInput({ units: '2.00' }));
  expect(result.balance.available).toBe('2.00');
  expect(await sumAvailableTransactionDeltas(result.balanceId)).toBe('2.00');
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/hours
pnpm --filter @member-course/api test:integration -- test/integration/hour-ledger.integration-spec.ts
~~~

Expected: FAIL because the allocation policy and ledger service are missing.

- [ ] **Step 3: Implement immutable posting**

Lock `StudentCourseBalance` first, then eligible `CoursePackage` rows ordered by `expiresOn, createdAt, id`. Update package buckets and summary in one transaction, append `HourTransaction` and one `HourAllocation` per package, and never expose update/delete operations for transactions or allocations. `businessKey` is unique.

- [ ] **Step 4: Verify invariants**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/hours
pnpm --filter @member-course/api test:integration -- test/integration/hour-ledger.integration-spec.ts
~~~

Expected: FEFO, decimal precision, idempotent order grant/reversal, rollback, and “balance equals transaction deltas” tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts/src/hours.ts packages/contracts/src/index.ts apps/api/src/modules/hours apps/api/test/integration/hour-ledger.integration-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): add hour ledger core"
~~~

### Task 9: Implement the Offline Order Lifecycle

**Files:**
- Create: `packages/contracts/src/order.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/modules/orders/domain/offline-order-state.ts`
- Test: `apps/api/src/modules/orders/domain/offline-order-state.spec.ts`
- Create: `apps/api/src/modules/orders/application/offline-order.service.ts`
- Create: `apps/api/src/modules/orders/application/offline-order-query.service.ts`
- Create: `apps/api/src/modules/orders/presentation/admin/offline-order-admin.controller.ts`
- Create: `apps/api/src/modules/orders/presentation/admin/dto/offline-order.dto.ts`
- Create: `apps/api/src/modules/orders/orders.module.ts`
- Test: `apps/api/test/integration/offline-order.integration-spec.ts`
- Test: `apps/api/test/e2e/offline-order.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `IdempotencyService`, catalog snapshot, `HourLedgerService.grantOrder/reverseOrder`.
- Produces:

~~~ts
createDraft(command: CreateOfflineOrderCommand, adminId: string): Promise<OfflineOrderDto>;
confirm(orderId: string, context: CommandContext): Promise<OfflineOrderDto>;
voidDraft(orderId: string, context: CommandContext): Promise<OfflineOrderDto>;
reverse(orderId: string, command: ReverseOfflineOrderCommand, context: CommandContext): Promise<OfflineOrderDto>;
~~~

- [ ] **Step 1: Write failing transactional tests**

~~~ts
it('confirms once and freezes the product snapshot', async () => {
  const draft = await createDraftFromProduct(product);
  await updateProduct(product.id, { price: '999.00', hours: '99.00' });
  const [first, second] = await Promise.all([
    confirmOrder(draft.id, 'confirm-key'),
    confirmOrder(draft.id, 'confirm-key'),
  ]);
  expect(first).toEqual(second);
  expect(await packageCountForOrder(draft.id)).toBe(1);
  expect(await grantCountForOrder(draft.id)).toBe(1);
  expect(first.items[0].unitPrice).toBe(draft.items[0].unitPrice);
});

it('reverses only a package with no posting after GRANT', async () => {
  const order = await confirmedOrder();
  await reverseOrder(order.id, 'reverse-1');
  expect(await orderStatus(order.id)).toBe('REVERSED');
  const used = await confirmedOrder();
  await seedLaterPostingForPackage(db, used.packageId);
  await expect(reverseOrder(used.id, 'reverse-2'))
    .rejects.toMatchObject({ code: 'ORDER_NOT_REVERSIBLE' });
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/orders/domain/offline-order-state.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/offline-order.integration-spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/offline-order.e2e-spec.ts
~~~

Expected: FAIL because the order service and routes are missing. Define `seedLaterPostingForPackage` inside `offline-order.integration-spec.ts`; it inserts one internally consistent post-GRANT transaction and allocation without depending on Task 10.

- [ ] **Step 3: Implement exact routes and transaction**

~~~text
GET   /api/admin/v1/orders
POST  /api/admin/v1/orders
GET   /api/admin/v1/orders/:id
POST  /api/admin/v1/orders/:id/confirm
POST  /api/admin/v1/orders/:id/void
POST  /api/admin/v1/orders/:id/reverse
~~~

Freeze product name, price, hours, and valid days when the draft item is created. On confirmation, use the Shanghai confirmation date and `validDays - 1` to compute inclusive expiry. In one transaction create packages, post `GRANT`, update balances, and mark the order `CONFIRMED`.

- [ ] **Step 4: Rerun target tests**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/orders/domain/offline-order-state.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/offline-order.integration-spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/offline-order.e2e-spec.ts
~~~

Expected: concurrent confirmation, snapshot immutability, draft void, confirmed immutability, strict reversal, and rollback tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts/src/order.ts packages/contracts/src/index.ts apps/api/src/modules/orders apps/api/test apps/api/src/app.module.ts
git commit -m "feat(api): add offline order lifecycle"
~~~

### Task 10: Add Manual Adjustments and Daily Expiration

**Files:**
- Modify: `apps/api/src/modules/hours/application/hour-ledger.service.ts`
- Create: `apps/api/src/modules/hours/application/hour-expiration.service.ts`
- Create: `apps/api/src/modules/hours/infrastructure/hour-expiration.job.ts`
- Create: `apps/api/src/modules/hours/presentation/admin/hour-admin.controller.ts`
- Create: `apps/api/src/modules/hours/presentation/admin/dto/hour-adjustment.dto.ts`
- Modify: `apps/api/src/modules/hours/hours.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/contracts/src/hours.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/test/integration/manual-hour-adjustment.integration-spec.ts`
- Test: `apps/api/test/integration/hour-expiration.integration-spec.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces:

~~~ts
export interface ManualGrantCommand {
  studentId: string;
  courseId: string;
  units: DecimalString;
  startsOn: string;
  expiresOn: string;
  reason: string;
}

export interface ManualDebitCommand {
  studentId: string;
  courseId: string;
  units: DecimalString;
  reason: string;
}

export interface ExpireBatchResult {
  scanned: number;
  processed: number;
  failed: number;
}

grantManual(command: ManualGrantCommand, context: CommandContext): Promise<HourPostingResult>;
debitManual(command: ManualDebitCommand, context: CommandContext): Promise<HourPostingResult>;
expireAvailable(
  tx: Prisma.TransactionClient,
  packageId: string,
  businessKey: string,
): Promise<HourPostingResult>;
HourExpirationService.expireDuePackages(now: Date, batchSize: number): Promise<ExpireBatchResult>;
~~~

- [ ] **Step 1: Write failing adjustment and boundary tests**

~~~ts
it('creates a separate MANUAL package and requires a reason', async () => {
  await grantManual({ studentId, courseId, units: '2.00', startsOn: '2026-07-23', expiresOn: '2026-08-31', reason: '补课' });
  expect(await latestPackage()).toMatchObject({ sourceType: 'MANUAL', granted: '2.00' });
});

it('expires packages at 00:05 Shanghai only when expiresOn is before today', async () => {
  await runExpiry('2026-08-01T16:04:59Z');
  expect(await expiredUnits(packageId)).toBe('0.00');
  await runExpiry('2026-08-01T16:05:00Z');
  expect(await expiredUnits(packageId)).toBe('2.00');
});

it('allows only one concurrent debit of the final hours', async () => {
  const results = await Promise.allSettled([
    debitManual(studentCourse, '2.00', 'key-1'),
    debitManual(studentCourse, '2.00', 'key-2'),
  ]);
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(await availableBalance(studentCourse)).toBe('0.00');
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test:integration -- test/integration/manual-hour-adjustment.integration-spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/hour-expiration.integration-spec.ts
~~~

Expected: FAIL because the adjustment endpoints and expiration job are missing.

- [ ] **Step 3: Implement exact commands**

Install and commit the scheduler dependency before registering the job:

~~~bash
pnpm --dir apps/api add @nestjs/schedule@^6
~~~

~~~text
POST /api/admin/v1/students/:studentId/courses/:courseId/hour-adjustments/grant
POST /api/admin/v1/students/:studentId/courses/:courseId/hour-adjustments/debit
~~~

Register `ScheduleModule.forRoot()` exactly once in `AppModule`, and register `HourExpirationJob` in `HoursModule`. Require a nonblank reason. Manual grant creates a separate `MANUAL` package. Manual debit uses FEFO. Neither operation may make available or reserved negative. `HourExpirationJob` runs at `00:05 Asia/Shanghai` and calls `HourExpirationService.expireDuePackages`; that service batches due packages and calls `HourLedgerService.expireAvailable` inside each locked transaction. Expire only available units on packages with `expiresOn < today`; M1 never changes reserved units. Use deterministic business keys `expiry:<packageId>:<businessDate>` for reruns.

- [ ] **Step 4: Rerun and pass**

Run:

~~~bash
pnpm --filter @member-course/api test:integration -- test/integration/manual-hour-adjustment.integration-spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/hour-expiration.integration-spec.ts
~~~

Expected: grant, debit, reason validation, negative protection, exact time boundary, and idempotent rerun tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/hours apps/api/src/app.module.ts apps/api/test/integration packages/contracts/src/hours.ts packages/contracts/src/index.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add manual hour adjustments and expiry"
~~~

### Task 11: Expose Authorized Member Asset Queries

**Files:**
- Create: `apps/api/src/modules/hours/application/member-asset-query.service.ts`
- Create: `apps/api/src/modules/hours/presentation/mini/member-asset-mini.controller.ts`
- Create: `apps/api/src/modules/hours/presentation/admin/member-asset-admin.controller.ts`
- Create: `apps/api/src/modules/orders/presentation/mini/offline-order-mini.controller.ts`
- Modify: `apps/api/src/modules/hours/hours.module.ts`
- Modify: `apps/api/src/modules/orders/orders.module.ts`
- Test: `apps/api/test/e2e/member-assets.e2e-spec.ts`
- Modify: `packages/contracts/src/hours.ts`
- Modify: `packages/contracts/src/order.ts`

**Interfaces:**
- Consumes: `StudentAccessService.assertRelated`.
- Produces: paginated order, package, balance, and transaction reads with decimal strings.

- [ ] **Step 1: Write failing isolation tests**

~~~ts
it('returns assets only for a related student', async () => {
  await listBalances(memberToken, relatedStudent.id, 200);
  await listBalances(memberToken, unrelatedStudent.id, 403, 'STUDENT_FORBIDDEN');
});

it('does not return another buyer account order', async () => {
  const result = await listMiniOrders(memberToken);
  expect(result.items.map((item) => item.id)).not.toContain(otherBuyerOrder.id);
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test:e2e -- test/e2e/member-assets.e2e-spec.ts`

Expected: FAIL with 404 for the asset routes.

- [ ] **Step 3: Implement exact query routes**

~~~text
GET /api/mini/v1/orders
GET /api/mini/v1/orders/:id
GET /api/mini/v1/students/:studentId/course-balances
GET /api/mini/v1/students/:studentId/course-packages
GET /api/mini/v1/students/:studentId/hour-transactions
~~~

Use the shared `page/pageSize/sort` contract. Return all decimal fields as canonical two-decimal strings. Check student relation before reading cached or database data.

- [ ] **Step 4: Rerun and pass**

Run: `pnpm --filter @member-course/api test:e2e -- test/e2e/member-assets.e2e-spec.ts`

Expected: pagination, relation isolation, buyer isolation, and decimal serialization tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/hours apps/api/src/modules/orders packages/contracts apps/api/test/e2e/member-assets.e2e-spec.ts
git commit -m "feat(api): expose member asset queries"
~~~

### Task 12: Build the Admin Login, Member, and Catalog Workspace

**Files:**
- Create: `apps/admin-web/src/api/http.ts`
- Create: `apps/admin-web/src/api/auth.ts`
- Create: `apps/admin-web/src/api/members.ts`
- Create: `apps/admin-web/src/api/catalog.ts`
- Create: `apps/admin-web/src/router/index.ts`
- Create: `apps/admin-web/src/stores/auth.ts`
- Create: `apps/admin-web/src/layouts/AdminLayout.vue`
- Test: `apps/admin-web/src/layouts/AdminLayout.spec.ts`
- Create: `apps/admin-web/src/features/auth/LoginView.vue`
- Create: `apps/admin-web/src/features/members/MemberListView.vue`
- Create: `apps/admin-web/src/features/members/MemberDetailView.vue`
- Create: `apps/admin-web/src/features/members/StudentForm.vue`
- Create: `apps/admin-web/src/features/catalog/CourseListView.vue`
- Create: `apps/admin-web/src/features/catalog/CourseEditView.vue`
- Create: `apps/admin-web/src/features/catalog/PackageProductForm.vue`
- Test: `apps/admin-web/src/features/auth/LoginView.spec.ts`
- Test: `apps/admin-web/src/features/members/MemberListView.spec.ts`
- Test: `apps/admin-web/src/features/members/MemberDetailView.spec.ts`
- Test: `apps/admin-web/src/features/members/StudentForm.spec.ts`
- Test: `apps/admin-web/src/features/catalog/CourseListView.spec.ts`
- Test: `apps/admin-web/src/features/catalog/CourseEditView.spec.ts`
- Test: `apps/admin-web/src/features/catalog/PackageProductForm.spec.ts`
- Modify: `apps/admin-web/src/main.ts`
- Modify: `apps/admin-web/src/App.vue`

**Interfaces:**
- Consumes: Tasks 4, 6, and 7 APIs.
- Produces: protected admin shell and M1 member/catalog operations.

- [ ] **Step 1: Write failing component tests**

~~~ts
it('redirects an unauthenticated administrator to login', async () => {
  await router.push('/members');
  await router.isReady();
  expect(router.currentRoute.value.name).toBe('login');
});

it('pre-creates a child under the selected member', async () => {
  await wrapper.get('[data-testid="add-student"]').trigger('click');
  await wrapper.get('[name="displayName"]').setValue('小陈');
  await wrapper.get('form').trigger('submit');
  expect(api.createStudent).toHaveBeenCalledWith(memberId, expect.objectContaining({ displayName: '小陈' }));
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/admin-web test -- src/layouts/AdminLayout.spec.ts src/features/auth/LoginView.spec.ts src/features/members/MemberListView.spec.ts src/features/members/MemberDetailView.spec.ts src/features/members/StudentForm.spec.ts src/features/catalog/CourseListView.spec.ts src/features/catalog/CourseEditView.spec.ts src/features/catalog/PackageProductForm.spec.ts
~~~

Expected: FAIL because the components and router are missing.

- [ ] **Step 3: Implement the admin views**

The navigation contains only the routes implemented in this task: `会员学员` and `课程课包`. Use Element Plus form validation. Preserve exact API error messages and trace IDs. On refresh failure clear tokens and redirect to login. Task 13 adds `线下订单` and `课时管理` only after those views exist.

- [ ] **Step 4: Rerun and pass**

Run:

~~~bash
pnpm --filter @member-course/admin-web test -- src/layouts/AdminLayout.spec.ts src/features/auth/LoginView.spec.ts src/features/members/MemberListView.spec.ts src/features/members/MemberDetailView.spec.ts src/features/members/StudentForm.spec.ts src/features/catalog/CourseListView.spec.ts src/features/catalog/CourseEditView.spec.ts src/features/catalog/PackageProductForm.spec.ts
~~~

Expected: auth routing, phone search, student management, guardian confirmation, course/product edit, and archive confirmation tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/admin-web
git commit -m "feat(admin): add member and catalog management"
~~~

### Task 13: Build Admin Order and Lesson-Hour Pages

**Files:**
- Create: `apps/admin-web/src/api/orders.ts`
- Create: `apps/admin-web/src/api/hours.ts`
- Create: `apps/admin-web/src/features/orders/OrderListView.vue`
- Create: `apps/admin-web/src/features/orders/OrderCreateView.vue`
- Create: `apps/admin-web/src/features/orders/OrderDetailView.vue`
- Create: `apps/admin-web/src/features/hours/HourAdjustmentDialog.vue`
- Create: `apps/admin-web/src/features/hours/HourLedgerTable.vue`
- Test: `apps/admin-web/src/features/orders/OrderListView.spec.ts`
- Test: `apps/admin-web/src/features/orders/OrderCreateView.spec.ts`
- Test: `apps/admin-web/src/features/orders/OrderDetailView.spec.ts`
- Test: `apps/admin-web/src/features/hours/HourAdjustmentDialog.spec.ts`
- Test: `apps/admin-web/src/features/hours/HourLedgerTable.spec.ts`
- Modify: `apps/admin-web/src/router/index.ts`
- Modify: `apps/admin-web/src/layouts/AdminLayout.vue`
- Modify: `apps/admin-web/src/layouts/AdminLayout.spec.ts`

**Interfaces:**
- Consumes: Tasks 9-11 APIs.
- Produces: offline order and manual lesson-hour operator workflows.

- [ ] **Step 1: Write failing interaction tests**

~~~ts
it('uses one idempotency key for repeated confirm clicks', async () => {
  await confirmButton.trigger('click');
  await confirmButton.trigger('click');
  expect(api.confirmOrder).toHaveBeenCalledTimes(1);
});

it('requires a reason and preserves decimal text', async () => {
  await unitsInput.setValue('1.50');
  await submit.trigger('click');
  expect(api.grantHours).not.toHaveBeenCalled();
  await reasonInput.setValue('补课');
  await submit.trigger('click');
  expect(api.grantHours).toHaveBeenCalledWith(expect.objectContaining({ units: '1.50', reason: '补课' }));
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/admin-web test -- src/layouts/AdminLayout.spec.ts src/features/orders/OrderListView.spec.ts src/features/orders/OrderCreateView.spec.ts src/features/orders/OrderDetailView.spec.ts src/features/hours/HourAdjustmentDialog.spec.ts src/features/hours/HourLedgerTable.spec.ts
~~~

Expected: FAIL because the order and hour views are missing.

- [ ] **Step 3: Implement exact behavior**

Add the `线下订单` and `课时管理` routes and navigation entries in this task. Disable confirmed-order editing. Show why a used order cannot be reversed. Keep decimal values as strings in forms and tables. Refresh order, package, balance, and transaction panels after a successful command.

- [ ] **Step 4: Run target tests**

Run:

~~~bash
pnpm --filter @member-course/admin-web test -- src/layouts/AdminLayout.spec.ts src/features/orders/OrderListView.spec.ts src/features/orders/OrderCreateView.spec.ts src/features/orders/OrderDetailView.spec.ts src/features/hours/HourAdjustmentDialog.spec.ts src/features/hours/HourLedgerTable.spec.ts
~~~

Expected: double-submit, reversal reason, required adjustment reason, and refresh tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/admin-web/src/api apps/admin-web/src/features apps/admin-web/src/router apps/admin-web/src/layouts/AdminLayout.vue apps/admin-web/src/layouts/AdminLayout.spec.ts
git commit -m "feat(admin): add offline order and hour management"
~~~

### Task 14: Build Mini-Program Login, Students, and Public Catalog

**Files:**
- Create: `apps/miniapp/miniprogram/services/http.ts`
- Create: `apps/miniapp/miniprogram/services/auth.ts`
- Create: `apps/miniapp/miniprogram/services/navigation.ts`
- Create: `apps/miniapp/miniprogram/stores/session-store.ts`
- Create: `apps/miniapp/miniprogram/stores/current-student-store.ts`
- Create: `apps/miniapp/miniprogram/pages/login/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/bind-phone/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/students/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/student-edit/index.{ts,json,wxml,wxss}`
- Modify: `apps/miniapp/miniprogram/pages/courses/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/course-detail/index.{ts,json,wxml,wxss}`
- Test: `apps/miniapp/tests/auth-flow.spec.ts`
- Test: `apps/miniapp/tests/student-switch.spec.ts`
- Test: `apps/miniapp/tests/pages/login.spec.ts`
- Test: `apps/miniapp/tests/pages/bind-phone.spec.ts`
- Test: `apps/miniapp/tests/pages/students.spec.ts`
- Test: `apps/miniapp/tests/pages/student-edit.spec.ts`
- Test: `apps/miniapp/tests/pages/courses.spec.ts`
- Test: `apps/miniapp/tests/pages/course-detail.spec.ts`
- Modify: `apps/miniapp/miniprogram/app.json`

**Interfaces:**
- Consumes: mini auth, member, and catalog APIs.
- Produces: bound session and current-student stores used by every later mini-program page.

- [ ] **Step 1: Write failing store tests**

~~~ts
it('allows public courses before phone binding but blocks private navigation', async () => {
  sessionStore.setSession({ bound: false, accessToken: 'token' });
  expect(canOpen('/pages/courses/index')).toBe(true);
  expect(canOpen('/pages/students/index')).toBe(false);
});

it('restores the selected related student only', async () => {
  currentStudentStore.restore([{ id: 'student-1' }], 'student-other');
  expect(currentStudentStore.currentId).toBe('student-1');
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/miniapp test -- tests/auth-flow.spec.ts tests/student-switch.spec.ts tests/pages/login.spec.ts tests/pages/bind-phone.spec.ts tests/pages/students.spec.ts tests/pages/student-edit.spec.ts tests/pages/courses.spec.ts tests/pages/course-detail.spec.ts
~~~

Expected: FAIL because the stores, navigation policy, and pages are missing.

- [ ] **Step 3: Implement native pages**

Use `wx.login` and `getPhoneNumber` codes only; never send decrypted phone data from the client. Keep the access token in memory. Store only the refresh token under the fixed `member-course:refresh-token` key through `wx.setStorageSync`; clear it on logout, refresh failure, or account change, and never persist phone numbers or student profile payloads. M1 tab bar contains only `课程` and `我的`. Display real empty states; do not add schedule or activity placeholders.

- [ ] **Step 4: Run mini-program tests**

Run:

~~~bash
pnpm --filter @member-course/miniapp test -- tests/auth-flow.spec.ts tests/student-switch.spec.ts tests/pages/login.spec.ts tests/pages/bind-phone.spec.ts tests/pages/students.spec.ts tests/pages/student-edit.spec.ts tests/pages/courses.spec.ts tests/pages/course-detail.spec.ts
~~~

Expected: login, binding, pre-created-child visibility, public/private gating, and student-switch persistence tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/miniapp
git commit -m "feat(miniapp): add onboarding students and catalog"
~~~

### Task 15: Build Mini-Program Order and Lesson-Hour Asset Views

**Files:**
- Create: `apps/miniapp/miniprogram/services/assets.ts`
- Create: `apps/miniapp/miniprogram/components/student-switcher/index.{ts,json,wxml,wxss}`
- Modify: `apps/miniapp/miniprogram/pages/my/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/orders/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/order-detail/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/packages/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/hour-transactions/index.{ts,json,wxml,wxss}`
- Test: `apps/miniapp/tests/member-assets.spec.ts`
- Test: `apps/miniapp/tests/components/student-switcher.spec.ts`
- Test: `apps/miniapp/tests/pages/my-assets.spec.ts`
- Test: `apps/miniapp/tests/pages/orders.spec.ts`
- Test: `apps/miniapp/tests/pages/order-detail.spec.ts`
- Test: `apps/miniapp/tests/pages/packages.spec.ts`
- Test: `apps/miniapp/tests/pages/hour-transactions.spec.ts`
- Modify: `apps/miniapp/miniprogram/app.json`

**Interfaces:**
- Consumes: Task 11 query APIs and current-student store.
- Produces: M1 member-visible order, package, balance, and posting history.

- [ ] **Step 1: Write failing data-isolation tests**

~~~ts
it('clears old assets when switching students', async () => {
  await page.loadStudent('student-1');
  await page.switchStudent('student-2');
  expect(page.data.packages).toEqual(student2Packages);
  expect(page.data.packages).not.toContainEqual(expect.objectContaining({ id: 'student-1-package' }));
});

it('clears cached data after STUDENT_FORBIDDEN', async () => {
  api.listPackages.mockRejectedValueOnce(businessError('STUDENT_FORBIDDEN'));
  await page.loadStudent('student-other');
  expect(page.data.packages).toEqual([]);
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/miniapp test -- tests/member-assets.spec.ts tests/components/student-switcher.spec.ts tests/pages/my-assets.spec.ts tests/pages/orders.spec.ts tests/pages/order-detail.spec.ts tests/pages/packages.spec.ts tests/pages/hour-transactions.spec.ts
~~~

Expected: FAIL because the asset pages and student switcher are missing.

- [ ] **Step 3: Implement exact displays**

Show order snapshots, package effective/expiry dates, and available/reserved/consumed/expired buckets. Show transaction type, amount, occurred time, and manual reason. Do not expose payment, refund, booking, or activity actions.

- [ ] **Step 4: Run tests**

Run:

~~~bash
pnpm --filter @member-course/miniapp test -- tests/member-assets.spec.ts tests/components/student-switcher.spec.ts tests/pages/my-assets.spec.ts tests/pages/orders.spec.ts tests/pages/order-detail.spec.ts tests/pages/packages.spec.ts tests/pages/hour-transactions.spec.ts
~~~

Expected: student isolation, decimal display, expired package, manual reason, empty state, and authorization reset tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/miniapp
git commit -m "feat(miniapp): add order package and hour views"
~~~

### Task 16: Verify the M1 End-to-End Journey and CI Gate

**Files:**
- Create: `apps/api/test/e2e/m1-member-assets-journey.e2e-spec.ts`
- Create: `apps/api/test/integration/m1-concurrency.integration-spec.ts`
- Create: `apps/api/test/helpers/m1-journey-driver.ts`
- Create: `apps/admin-web/e2e/m1-admin-flow.spec.ts`
- Create: `apps/admin-web/playwright.config.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `apps/admin-web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: all M1 tasks.
- Produces: reproducible M1 acceptance gate and CI workflow.

Install and commit Playwright before writing or running the browser test:

~~~bash
pnpm --dir apps/admin-web add -D @playwright/test
pnpm --filter @member-course/admin-web exec playwright install chromium
~~~

- [ ] **Step 1: Write the failing closed-loop test**

~~~ts
it('completes the M1 member asset journey', async () => {
  const member = await admin.precreateMemberWithChild();
  const session = await mini.bindWechatToPhone(member.phone);
  const product = await admin.createCourseAndPackage();
  const order = await admin.createOrder(member.childId, product.id);
  const [first, retry] = await Promise.all([
    admin.confirmOrder(order.id, 'confirm-order-1'),
    admin.confirmOrder(order.id, 'confirm-order-1'),
  ]);
  expect(first).toEqual(retry);
  expect(await db.coursePackage.count({ where: { sourceOrderItemId: order.itemId } })).toBe(1);
  expect(await db.hourTransaction.count({ where: { businessKey: 'order:' + order.itemId + ':grant' } })).toBe(1);
  expect(await mini.listBalances(session, member.childId)).toContainEqual(expect.objectContaining({ available: product.hours }));
});
~~~

Implement `m1-journey-driver.ts` with the concrete `admin`, `mini`, and `db` drivers imported by this test; do not rely on undeclared globals or a test helper from a later milestone.

- [ ] **Step 2: Add explicit failure assertions**

Extend the journey to assert `STUDENT_FORBIDDEN` for another account, successful reversal for an untouched order, and `ORDER_NOT_REVERSIBLE` after any later posting.

- [ ] **Step 3: Run the journey**

Run:

~~~bash
pnpm --filter @member-course/api test:e2e -- test/e2e/m1-member-assets-journey.e2e-spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/m1-concurrency.integration-spec.ts
pnpm --filter @member-course/admin-web test:e2e -- e2e/m1-admin-flow.spec.ts
~~~

Expected before CI wiring: test passes locally against Testcontainers MySQL and Playwright admin flow.

- [ ] **Step 4: Add CI**

CI starts MySQL 8.4 and runs:

~~~bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @member-course/api test:integration
pnpm --filter @member-course/api test:e2e
pnpm --filter @member-course/admin-web test:e2e
pnpm build
pnpm --filter @member-course/api prisma validate
git diff --check
~~~

Expected: every command exits 0 on a clean checkout.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/test apps/admin-web/e2e apps/admin-web/playwright.config.ts apps/admin-web/package.json pnpm-lock.yaml .github/workflows/ci.yml package.json README.md
git commit -m "test: verify m1 membership and hour asset journey"
~~~

## M1 Completion Gate

M1 is complete only when the automated journey proves:

1. Administrator pre-creates a member and child.
2. A provisional WeChat identity binds the same phone and atomically migrates.
3. Administrator creates a course and package product.
4. Repeated order confirmation creates exactly one sales package and one `GRANT` posting.
5. Manual grant and FEFO debit preserve exact decimal balances.
6. The related mini-program account reads the correct order, package, balance, and transactions.
7. An unrelated account receives `STUDENT_FORBIDDEN` without stale-data leakage.
8. An untouched order reverses; any order with a later posting does not.
9. The repository-wide verification commands pass and `git status --short` is empty.
