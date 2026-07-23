# M3 Activities, Notifications, and Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the product with activity registration and attendance, durable WeChat subscription messages, operational dashboards and audited exports, legal/account-deletion flows, institution settings, administrator and media management, the mini home, observability, backup recovery, and the final production acceptance gate.

**Architecture:** Add `audit`, `notifications`, `activities`, `dashboard`, `settings`, `media`, `home`, and privacy operations to the existing NestJS modular monolith. Business transactions append audit records and notification outbox rows in MySQL; external WeChat and S3-compatible calls run outside business transactions behind explicit completion checks. Activities reuse M2 student conflict and M1/M2 lesson-hour allocation services, so there is still one source of truth for capacity, schedule, and hours.

**Tech Stack:** Existing M1/M2 stack plus `@nestjs/schedule`, `sanitize-html`, AWS SDK v3 for S3-compatible storage, Pino structured logging, `@nestjs/throttler`, Prometheus metrics, MySQL `FOR UPDATE SKIP LOCKED`, CSV streaming, k6, shell-based backup/restore verification, and real WeChat test-account integration.

## Global Constraints

- Repository: `https://github.com/Broccoli-X/member-course-miniapp.git`.
- Prerequisite: M1 and M2 completion gates pass on the same branch.
- Activities have registration windows, capacity, optional offline fee markers, and optional lesson-hour deduction tied to exactly one course.
- If an activity deducts hours, registration reserves them and check-in consumes them. User cancel, no-show, or institution cancel releases the original allocation.
- Activity no-show never charges hours in M3.
- Manual and automatic activity settlement share one idempotent command; automatic eligibility begins exactly 30 minutes after end.
- Notification uniqueness is `domainEventId + aggregateVersion + messageType + recipientAccountId`.
- A notification failure cannot roll back or change business state.
- Pending reminders from old object versions are cancelled and rebuilt; already sent messages receive a corrective message.
- Audit rows are append-only and in the same database transaction as the business change.
- Exported contact data is masked; every export is audited; CSV formula injection must be neutralized.
- An account with a deletion request may read history but cannot create a booking or activity registration.
- Account deletion never automatically reverses orders or lesson hours and never relinks historical assets to a later registration.
- Production acceptance requires real backup restore, real WeChat test-account messaging, alerts, and a 50-concurrent-user performance run.
- Do not introduce Redis, a message queue, multi-campus support, online payment, SMS, or a teacher portal.

---

## Locked M3 File Map

~~~text
apps/api/src/modules/audit/
apps/api/src/modules/notifications/
apps/api/src/modules/activities/
apps/api/src/modules/dashboard/
apps/api/src/modules/settings/
apps/api/src/modules/media/
apps/api/src/modules/home/
apps/api/src/modules/identity/application/account-deletion.service.ts
apps/api/src/modules/identity/application/account-write-policy.service.ts
apps/api/src/platform/observability/
apps/admin-web/src/features/activities/
apps/admin-web/src/features/notifications/
apps/admin-web/src/features/audit/
apps/admin-web/src/features/settings/
apps/admin-web/src/features/media/
apps/miniapp/miniprogram/pages/activity/
apps/miniapp/miniprogram/pages/home/
apps/miniapp/miniprogram/pages/settings/
deploy/prometheus/
scripts/
docs/runbooks/
~~~

### Task 1: Persist Critical Operation Audit Events

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/202607230003_audit/migration.sql`
- Create: `packages/contracts/src/audit.ts`
- Create: `apps/api/src/modules/audit/domain/audit-event.ts`
- Create: `apps/api/src/modules/audit/application/audit-writer.service.ts`
- Create: `apps/api/src/modules/audit/application/audit-query.service.ts`
- Create: `apps/api/src/modules/audit/presentation/admin/audit-admin.controller.ts`
- Create: `apps/api/src/modules/audit/audit.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/admin-web/src/api/audit.ts`
- Create: `apps/admin-web/src/features/audit/AuditLogView.vue`
- Test: `apps/admin-web/src/features/audit/AuditLogView.spec.ts`
- Modify: `apps/admin-web/src/router/index.ts`
- Modify: `apps/admin-web/src/layouts/AdminLayout.vue`
- Test: `apps/api/test/integration/audit/audit-writer.integration-spec.ts`
- Test: `apps/api/test/e2e/audit-logs.e2e-spec.ts`
- Modify: `apps/api/src/modules/orders/application/offline-order.service.ts`
- Modify: `apps/api/src/modules/hours/application/hour-ledger.service.ts`
- Modify: `apps/api/src/modules/identity/application/member-admin.service.ts`
- Modify: `apps/api/src/modules/identity/application/student-profile.service.ts`
- Modify: `apps/api/src/modules/identity/application/account-student-relation.service.ts`
- Modify: `apps/api/src/modules/bookings/application/booking-command.service.ts`
- Modify: `apps/api/src/modules/bookings/application/attendance-command.service.ts`
- Modify: `apps/api/src/modules/bookings/application/published-session-command.service.ts`
- Modify: `apps/api/src/modules/scheduling/application/session-command.service.ts`

**Interfaces:**
- Consumes: `CommandContext` and Prisma transactions.
- Produces:

~~~ts
export interface AuditEvent {
  actorType: 'ADMIN' | 'MEMBER' | 'SYSTEM';
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  requestId: string;
}

record(tx: Prisma.TransactionClient, event: AuditEvent): Promise<void>;
~~~

- [ ] **Step 1: Write failing atomicity and masking tests**

~~~ts
it('rolls back audit when the business transaction fails', async () => {
  await expect(runFailingOrderChange()).rejects.toBeDefined();
  expect(await auditCountForRequest(requestId)).toBe(0);
});

it('stores masked phone data and immutable before/after values', async () => {
  await updateMemberPhone();
  const event = await latestAudit();
  expect(JSON.stringify(event.before)).not.toContain('13800000000');
  expect(JSON.stringify(event.after)).toContain('138****0000');
  await expect(updateAuditRow(event.id)).rejects.toBeDefined();
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test:integration -- test/integration/audit/audit-writer.integration-spec.ts`

Expected: FAIL because `AuditLog` and `AuditWriterService` do not exist.

- [ ] **Step 3: Implement append-only audit and retrofit commands**

Call `record(tx, event)` from:

~~~text
orders/application/offline-order.service.ts
hours/application/hour-ledger.service.ts
identity/application/member-admin.service.ts
identity/application/student-profile.service.ts
identity/application/account-student-relation.service.ts
bookings/application/booking-command.service.ts
bookings/application/attendance-command.service.ts
bookings/application/published-session-command.service.ts
scheduling/application/session-command.service.ts
~~~

Sanitize direct identifiers before persistence. The migration installs `BEFORE UPDATE` and `BEFORE DELETE` triggers for `AuditLog`, so append-only behavior is enforced even through a direct Prisma call. Do not expose repository update/delete methods. System jobs set `actorType=SYSTEM` and `actorId=null`.

- [ ] **Step 4: Add and verify query API and admin log view**

Implement `GET /api/admin/v1/audit-logs` with filters `objectType`, `objectId`, `actorType`, `actorId`, `requestId`, and date range. Add a dense admin list with these filters and a before/after detail drawer. Expected: API pagination/filter tests and view filter/detail tests pass.

Run:

~~~bash
pnpm --filter @member-course/api test:e2e -- test/e2e/audit-logs.e2e-spec.ts
pnpm --filter @member-course/admin-web test -- src/features/audit/AuditLogView.spec.ts
~~~

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/prisma packages/contracts/src/audit.ts packages/contracts/src/index.ts apps/api/src/app.module.ts apps/api/src/modules/audit apps/api/src/modules/identity apps/api/src/modules/orders apps/api/src/modules/hours apps/api/src/modules/bookings apps/api/src/modules/scheduling apps/api/test/integration/audit apps/api/test/e2e/audit-logs.e2e-spec.ts apps/admin-web/src/api/audit.ts apps/admin-web/src/features/audit apps/admin-web/src/router/index.ts apps/admin-web/src/layouts/AdminLayout.vue
git commit -m "feat(audit): persist critical operation audit events"
~~~

### Task 2: Add the Durable WeChat Notification Outbox

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/202607230004_notification_outbox/migration.sql`
- Create: `packages/contracts/src/notification.ts`
- Create: `apps/api/src/modules/notifications/application/notification-outbox.service.ts`
- Create: `apps/api/src/modules/notifications/application/subscription-consent.service.ts`
- Create: `apps/api/src/modules/notifications/application/outbox-worker.service.ts`
- Create: `apps/api/src/modules/notifications/infrastructure/wechat-message.client.ts`
- Create: `apps/api/src/modules/notifications/infrastructure/outbox-lock.repository.ts`
- Create: `apps/api/src/modules/notifications/jobs/outbox-worker.job.ts`
- Create: `apps/api/src/modules/notifications/notifications.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/integration/notifications/outbox.integration-spec.ts`

**Interfaces:**
- Produces:

~~~ts
enqueue(
  tx: Prisma.TransactionClient,
  input: EnqueueNotificationInput,
): Promise<{ id: string; created: boolean }>;

invalidatePending(
  tx: Prisma.TransactionClient,
  input: {
    aggregateType: string;
    aggregateId: string;
    messageTypes: NotificationType[];
    olderThanVersion: number;
    reason: string;
  },
): Promise<number>;

tick(now: Date): Promise<number>;
~~~

- [ ] **Step 1: Write failing outbox tests**

~~~ts
it('deduplicates one domain event but permits a later aggregate version', async () => {
  expect((await enqueue(eventV1)).created).toBe(true);
  expect((await enqueue(eventV1)).created).toBe(false);
  expect((await enqueue({ ...eventV1, aggregateVersion: 2 })).created).toBe(true);
});

it('marks no-consent work skipped without calling WeChat', async () => {
  await enqueue(eventWithoutConsent);
  await worker.tick(now);
  expect(wechat.send).not.toHaveBeenCalled();
  expect(await outboxStatus(eventWithoutConsent)).toBe('SKIPPED_NO_CONSENT');
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test:integration -- test/integration/notifications/outbox.integration-spec.ts`

Expected: outbox models and worker missing.

- [ ] **Step 3: Implement states and claim protocol**

Use `PENDING, CLAIMED, SENDING, SENT, RETRY, CANCELLED, SKIPPED_NO_CONSENT, DELIVERY_UNKNOWN, DEAD`. Claim batches using a short database transaction, `FOR UPDATE SKIP LOCKED`, and a lease timestamp. Commit the claim before calling WeChat. Use a conditional update from `CLAIMED` to `SENDING`; if invalidation changed it to `CANCELLED`, do not send. Record every attempt. A worker restart may reclaim `CLAIMED`, but it must never automatically resend an expired `SENDING` row because WeChat may already have accepted it; move that row to `DELIVERY_UNKNOWN` for explicit administrator reconciliation.

- [ ] **Step 4: Verify recovery**

Add tests for exponential retry, maximum attempts to `DEAD`, expired-`CLAIMED` recovery, concurrent workers, a process failure after claim but before `SENDING`, and a process failure after the WeChat call while the row remains `SENDING`. The last case must become `DELIVERY_UNKNOWN` and must not be reclaimed automatically. Expected: no automatic duplicate send for one event, ambiguous delivery requires explicit reconciliation, and business rows remain committed on WeChat failure.

Run: `pnpm --filter @member-course/api test:integration -- test/integration/notifications/outbox.integration-spec.ts`

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/prisma packages/contracts/src/notification.ts packages/contracts/src/index.ts apps/api/src/app.module.ts apps/api/src/modules/notifications apps/api/test/integration/notifications
git commit -m "feat(notifications): add durable wechat outbox"
~~~

### Task 3: Add Activity Draft, Publish, and Query

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/202607230005_activity_catalog/migration.sql`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/contracts/src/activity.ts`
- Create: `apps/api/src/modules/activities/domain/activity.types.ts`
- Create: `apps/api/src/modules/activities/application/activity-command.service.ts`
- Create: `apps/api/src/modules/activities/application/activity-query.service.ts`
- Create: `apps/api/src/modules/activities/presentation/admin/activity-admin.controller.ts`
- Create: `apps/api/src/modules/activities/presentation/mini/activity-mini.controller.ts`
- Create: `apps/api/src/modules/activities/activities.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/src/modules/activities/application/activity-command.service.spec.ts`
- Test: `apps/api/test/e2e/activities.e2e-spec.ts`

**Interfaces:**
- Produces `create`, `update`, `publish`, public listing, and versioned activity events. Institution cancellation is added in Task 5, after registration and hour-release dependencies exist.

- [ ] **Step 1: Write failing publish-policy tests**

~~~ts
it.each([
  [{ courseId, hours: null }, 'ACTIVITY_HOUR_POLICY_INVALID'],
  [{ courseId: null, hours: '1.00' }, 'ACTIVITY_HOUR_POLICY_INVALID'],
  [{ courseId, hours: '0.00' }, 'ACTIVITY_HOUR_POLICY_INVALID'],
])('requires course and positive hours together', async (policy, code) => {
  await expect(service.publish(await draftWith(policy), adminContext))
    .rejects.toMatchObject({ code });
});

it('sanitizes published rich text', async () => {
  const activity = await service.publish(await draftWithHtml('<p>开放日</p><script>alert(1)</script>'), adminContext);
  expect(activity.contentHtml).toBe('<p>开放日</p>');
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test -- src/modules/activities/application/activity-command.service.spec.ts`

Expected: activity module missing.

- [ ] **Step 3: Implement model and state commands**

Run:

~~~bash
pnpm --filter @member-course/api add sanitize-html
pnpm --filter @member-course/api add -D @types/sanitize-html
~~~

`Activity` contains title, sanitized HTML, registration start/end, activity start/end, capacity, fee mode, optional course/hour policy, status, version, and schedule version. Validate `registrationStart < registrationEnd <= activityStart < activityEnd`. Published public queries return only current published records. Reminder `aggregateVersion` always uses `scheduleVersion`; ordinary optimistic updates continue to use `version`. Create, update, and publish append an `AuditLog` through Task 1's `AuditWriterService` in the same transaction.

- [ ] **Step 4: Implement routes and pass**

~~~text
GET/POST/PATCH /api/admin/v1/activities
POST           /api/admin/v1/activities/:id/publish
GET            /api/mini/v1/activities
GET            /api/mini/v1/activities/:id
~~~

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/activities/application/activity-command.service.spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/activities.e2e-spec.ts
~~~

Expected: state, window, capacity, fee, hour policy, sanitization, archive, and version tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/prisma apps/api/package.json pnpm-lock.yaml packages/contracts/src/activity.ts packages/contracts/src/index.ts apps/api/src/app.module.ts apps/api/src/modules/activities apps/api/test/e2e/activities.e2e-spec.ts
git commit -m "feat(activity): add activity catalog and publishing"
~~~

### Task 4: Register Students and Reserve Optional Activity Hours

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/202607230006_activity_registration/migration.sql`
- Modify: `packages/contracts/src/activity.ts`
- Create: `apps/api/src/modules/activities/application/activity-registration.service.ts`
- Create: `apps/api/src/modules/activities/infrastructure/activity-lock.repository.ts`
- Create: `apps/api/src/modules/activities/presentation/admin/activity-registration-admin.controller.ts`
- Create: `apps/api/src/modules/activities/presentation/mini/activity-registration-mini.controller.ts`
- Modify: `apps/api/src/modules/bookings/application/student-schedule-conflict.service.ts`
- Test: `apps/api/test/integration/activities/activity-registration.integration-spec.ts`

**Interfaces:**
- Consumes: `StudentAccessService`, `HourLedgerService.reserve/releaseReserved`, and `StudentScheduleOccupancyProvider`.
- Produces:

~~~ts
register(command: RegisterActivityCommand, ctx: MemberOrAdminCommandContext): Promise<ActivityRegistrationDto>;
cancel(command: CancelActivityRegistrationCommand, ctx: MemberOrAdminCommandContext): Promise<ActivityRegistrationDto>;
updateFeeStatus(command: UpdateActivityFeeStatusCommand, ctx: CommandContext): Promise<ActivityRegistrationDto>;
~~~

- [ ] **Step 1: Write failing capacity, conflict, and re-registration tests**

~~~ts
it('permits one winner for the last activity seat', async () => {
  const results = await Promise.allSettled([register(studentA), register(studentB)]);
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
});

it('creates a new attempt after cancellation and releases original hours', async () => {
  const first = await register(studentA);
  await cancel(first.id);
  const second = await register(studentA);
  expect(second.attemptNo).toBe(first.attemptNo + 1);
  expect(await activeRegistrationCount(studentA)).toBe(1);
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test:integration -- test/integration/activities/activity-registration.integration-spec.ts`

Expected: registration schema and service missing.

- [ ] **Step 3: Implement transaction and active uniqueness**

Add `ActivityRegistration` with `attemptNo` and nullable unique `activeKey`. Lock `StudentProfile → Activity → StudentCourseBalance → CoursePackage`. Recheck member relation, current account status `ACTIVE`, registration window, time overlap, capacity, and lesson hours. Extend occupancy lookup to include active bookings and registrations using `startAt < otherEnd && endAt > otherStart`. Registration, member/admin cancellation, and fee-status changes append audit records in their business transactions.

- [ ] **Step 4: Implement routes and pass**

~~~text
GET  /api/admin/v1/activities/:id/registrations
POST /api/admin/v1/activities/:id/students/:studentId/registrations
POST /api/admin/v1/activity-registrations/:id/cancel
POST /api/admin/v1/activity-registrations/:id/fee-status
GET  /api/mini/v1/students/:studentId/activity-registrations
POST /api/mini/v1/students/:studentId/activity-registrations
POST /api/mini/v1/activity-registrations/:id/cancel
~~~

Expected: relation, window, concurrency, overlap, reserve/release, expired return, attempt, idempotency, and informational fee-state tests pass.

Run: `pnpm --filter @member-course/api test:integration -- test/integration/activities/activity-registration.integration-spec.ts`

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/prisma apps/api/src/modules/activities apps/api/src/modules/bookings packages/contracts apps/api/test/integration/activities
git commit -m "feat(activity): register students and reserve hours"
~~~

### Task 5: Settle Activity Attendance and Auto-End Activities

**Files:**
- Create: `apps/api/src/modules/activities/application/activity-attendance.service.ts`
- Create: `apps/api/src/modules/activities/application/activity-settlement.service.ts`
- Modify: `apps/api/src/modules/activities/application/activity-command.service.ts`
- Modify: `apps/api/src/modules/activities/presentation/admin/activity-admin.controller.ts`
- Create: `apps/api/src/modules/activities/jobs/activity-settlement.job.ts`
- Create: `apps/api/src/modules/activities/presentation/admin/activity-attendance.controller.ts`
- Modify: `packages/contracts/src/activity.ts`
- Test: `apps/api/src/modules/activities/application/activity-settlement.service.spec.ts`
- Test: `apps/api/test/integration/activities/activity-settlement.integration-spec.ts`

**Interfaces:**
- Produces:

~~~ts
checkIn(command: SettleActivityAttendanceCommand, ctx: CommandContext): Promise<ActivityRegistrationDto>;
markNoShow(command: SettleActivityAttendanceCommand, ctx: CommandContext): Promise<ActivityRegistrationDto>;
settle(
  command: { activityId: string; mode: 'MANUAL' | 'AUTO'; now: Date; idempotencyKey: string },
  ctx: CommandContext,
): Promise<ActivitySettlementResult>;
~~~

- [ ] **Step 1: Write failing 30-minute and race tests**

~~~ts
it('is ineligible at 29:59 and eligible at 30:00', async () => {
  expect((await settleDue(add(endAt, { minutes: 29, seconds: 59 }))).processed).toBe(0);
  expect((await settleDue(add(endAt, { minutes: 30 }))).processed).toBe(1);
});

it('allows only check-in or cancellation to win', async () => {
  const results = await Promise.allSettled([checkIn(registrationId), cancel(registrationId)]);
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(await hourPostingCount(registrationId)).toBe(1);
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/activities/application/activity-settlement.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/activities/activity-settlement.integration-spec.ts
~~~

Expected: settlement service missing.

- [ ] **Step 3: Implement exact settlement policy**

Check-in calls `consumeReserved`. `NO_SHOW`, user cancel, and `ACTIVITY_CANCELLED` call `releaseReserved`. Activity no-show never charges. Manual settlement is allowed only after end. The leased job scans `endAt <= now - 30 minutes` and calls the same idempotent command. Set `ENDED` only when all active registrations close. Attendance and settlement transitions append audit records in the same transaction. Add `POST /api/admin/v1/activities/:id/cancel` here; its transaction locks the activity and every active registration, changes them to `ACTIVITY_CANCELLED`, releases each original allocation, appends audit records and a versioned cancellation event, and only then marks the activity `CANCELLED`. Task 7 consumes that event and writes the notification outbox row.

- [ ] **Step 4: Run target tests**

Expected: check-in, no-show, cancel, institution cancel, 29:59/30:00, rerun, race, empty activity, and lease recovery tests pass.

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/activities/application/activity-settlement.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/activities/activity-settlement.integration-spec.ts
~~~

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/activities packages/contracts/src/activity.ts apps/api/test/integration/activities
git commit -m "feat(activity): settle attendance and end activities"
~~~

### Task 6: Deliver Admin and Mini-Program Activity Journeys

**Files:**
- Create: `apps/admin-web/src/api/activities.ts`
- Create: `apps/admin-web/src/features/activities/ActivityListView.vue`
- Create: `apps/admin-web/src/features/activities/ActivityEditView.vue`
- Create: `apps/admin-web/src/features/activities/ActivityRosterView.vue`
- Test: `apps/admin-web/src/features/activities/ActivityListView.spec.ts`
- Test: `apps/admin-web/src/features/activities/ActivityEditView.spec.ts`
- Test: `apps/admin-web/src/features/activities/ActivityRosterView.spec.ts`
- Create: `apps/miniapp/miniprogram/services/activity.ts`
- Create: `apps/miniapp/miniprogram/pages/activity/list.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/activity/detail.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/activity/my-registrations.{ts,json,wxml,wxss}`
- Test: `apps/miniapp/tests/pages/activity/list.spec.ts`
- Test: `apps/miniapp/tests/pages/activity/detail.spec.ts`
- Test: `apps/miniapp/tests/pages/activity/my-registrations.spec.ts`
- Modify: `apps/admin-web/src/router/index.ts`
- Modify: `apps/admin-web/src/layouts/AdminLayout.vue`
- Modify: `apps/miniapp/miniprogram/app.json`
- Modify: `apps/miniapp/miniprogram/custom-tab-bar/index.{ts,json,wxml,wxss}`

**Interfaces:**
- Consumes: Tasks 3-5 APIs.
- Produces: activity publish, roster, fee/check-in admin flows and member browse/register/cancel flows.

- [ ] **Step 1: Write failing UI tests**

~~~ts
it('shows both offline fee and lesson-hour impact before registration', async () => {
  await page.load(activityWithFeeAndHours);
  expect(page.data.summary).toEqual(expect.objectContaining({ fee: '100.00', hours: '1.00', courseName: '绘画' }));
});

it('blocks registration for an unbound account', async () => {
  sessionStore.setSession({ bound: false });
  await page.register();
  expect(api.register).not.toHaveBeenCalled();
  expect(page.data.errorCode).toBe('PHONE_BINDING_REQUIRED');
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/admin-web test -- src/features/activities/ActivityListView.spec.ts src/features/activities/ActivityEditView.spec.ts src/features/activities/ActivityRosterView.spec.ts
pnpm --filter @member-course/miniapp test -- tests/pages/activity/list.spec.ts tests/pages/activity/detail.spec.ts tests/pages/activity/my-registrations.spec.ts
~~~

Expected: activity views/pages missing.

- [ ] **Step 3: Implement exact UI states**

Admin supports draft, publish, cancel, roster, manual fee status, check-in/no-show, and manual settlement. Mini shows registration window, seats, fee marker, course/hour cost, current attempt, cancel and attendance result. No online pay/refund controls.

- [ ] **Step 4: Run UI tests**

Expected: publish validation, roster, capacity, fee marker, register, cancel, check-in status, and student switch tests pass.

Run:

~~~bash
pnpm --filter @member-course/admin-web test -- src/features/activities/ActivityListView.spec.ts src/features/activities/ActivityEditView.spec.ts src/features/activities/ActivityRosterView.spec.ts
pnpm --filter @member-course/miniapp test -- tests/pages/activity/list.spec.ts tests/pages/activity/detail.spec.ts tests/pages/activity/my-registrations.spec.ts
~~~

- [ ] **Step 5: Commit**

~~~bash
git add apps/admin-web/src/api/activities.ts apps/admin-web/src/features/activities apps/admin-web/src/router/index.ts apps/admin-web/src/layouts/AdminLayout.vue apps/miniapp/miniprogram/services/activity.ts apps/miniapp/miniprogram/pages/activity apps/miniapp/miniprogram/app.json apps/miniapp/miniprogram/custom-tab-bar apps/miniapp/tests/pages/activity
git commit -m "feat(ui): deliver activity journeys"
~~~

### Task 7: Wire Versioned Reminders, Consent, and Notification Operations

**Files:**
- Create: `apps/api/src/modules/notifications/application/notification-event-handler.service.ts`
- Create: `apps/api/src/modules/notifications/jobs/reminder-planner.job.ts`
- Create: `apps/api/src/modules/notifications/jobs/package-reminder.job.ts`
- Create: `apps/api/src/modules/notifications/presentation/admin/notification-admin.controller.ts`
- Create: `apps/api/src/modules/notifications/presentation/mini/subscription-consent.controller.ts`
- Modify: `apps/api/src/modules/bookings/application/booking-command.service.ts`
- Modify: `apps/api/src/modules/bookings/application/attendance-command.service.ts`
- Modify: `apps/api/src/modules/bookings/application/published-session-command.service.ts`
- Modify: `apps/api/src/modules/scheduling/application/session-command.service.ts`
- Modify: `apps/api/src/modules/activities/application/activity-command.service.ts`
- Modify: `apps/api/src/modules/activities/application/activity-registration.service.ts`
- Modify: `apps/api/src/modules/activities/application/activity-settlement.service.ts`
- Modify: `packages/contracts/src/notification.ts`
- Create: `apps/admin-web/src/api/notifications.ts`
- Create: `apps/admin-web/src/features/notifications/NotificationQueueView.vue`
- Create: `apps/admin-web/src/features/notifications/NotificationTemplateView.vue`
- Test: `apps/admin-web/src/features/notifications/NotificationQueueView.spec.ts`
- Test: `apps/admin-web/src/features/notifications/NotificationTemplateView.spec.ts`
- Modify: `apps/admin-web/src/router/index.ts`
- Modify: `apps/admin-web/src/layouts/AdminLayout.vue`
- Create: `apps/miniapp/miniprogram/services/notification.ts`
- Create: `apps/miniapp/miniprogram/pages/settings/notifications.{ts,json,wxml,wxss}`
- Test: `apps/miniapp/tests/pages/settings/notifications.spec.ts`
- Modify: `apps/miniapp/miniprogram/app.json`
- Test: `apps/api/test/integration/notifications/reminder-versioning.integration-spec.ts`
- Test: `apps/api/test/e2e/notification-operations.e2e-spec.ts`

**Interfaces:**
- Consumes: M2 versioned events, M3 activity events, and Task 2 outbox.
- Produces: consent API, template configuration, reminder planning, queue/retry admin UI.

- [ ] **Step 1: Write failing versioning tests**

~~~ts
it('cancels an old reminder and creates the new schedule version', async () => {
  await planSessionReminder(sessionV1);
  await rescheduleSession(sessionV2);
  expect(await reminderStatus(sessionV1)).toBe('CANCELLED');
  expect(await reminderStatus(sessionV2)).toBe('PENDING');
});

it('keeps a sent message and appends a correction', async () => {
  await markSent(sessionV1);
  await rescheduleSession(sessionV2);
  expect(await reminderStatus(sessionV1)).toBe('SENT');
  expect(await correctionCount(sessionV2)).toBe(1);
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test:integration -- test/integration/notifications/reminder-versioning.integration-spec.ts`

Expected: no reminder event handler.

- [ ] **Step 3: Implement transaction wiring**

Within each session/activity/booking transaction, invalidate `PENDING, RETRY, CLAIMED` work for older versions and enqueue current-version work. Never rewrite `SENDING`, `SENT`, or `DELIVERY_UNKNOWN`. On cancellation, invalidate future reminders. Package reminders use package/version and the configured lead time. Always enqueue the durable intent; the worker checks saved member consent immediately before the conditional transition to `SENDING`.

- [ ] **Step 4: Implement UI/API and pass**

Admin can configure WeChat template IDs, view/retry `DEAD` items, reconcile `DELIVERY_UNKNOWN` items, and inspect attempts. Mini can request and persist each subscription consent. Expected: continuous reschedules, duplicate events, old reminder cancellation, sent correction, unknown-delivery isolation, failed send isolation, and consent tests pass.

Run:

~~~bash
pnpm --filter @member-course/api test:integration -- test/integration/notifications/reminder-versioning.integration-spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/notification-operations.e2e-spec.ts
pnpm --filter @member-course/admin-web test -- src/features/notifications/NotificationQueueView.spec.ts src/features/notifications/NotificationTemplateView.spec.ts
pnpm --filter @member-course/miniapp test -- tests/pages/settings/notifications.spec.ts
~~~

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/notifications apps/api/src/modules/bookings apps/api/src/modules/scheduling apps/api/src/modules/activities apps/api/test/e2e/notification-operations.e2e-spec.ts packages/contracts/src/notification.ts packages/contracts/src/index.ts apps/admin-web/src/api/notifications.ts apps/admin-web/src/features/notifications apps/admin-web/src/router/index.ts apps/admin-web/src/layouts/AdminLayout.vue apps/miniapp/miniprogram/services/notification.ts apps/miniapp/miniprogram/pages/settings/notifications.* apps/miniapp/miniprogram/app.json apps/miniapp/tests/pages/settings/notifications.spec.ts
git commit -m "feat(notifications): wire versioned reminders"
~~~

### Task 8: Add the Dashboard and Audited CSV Exports

**Files:**
- Create: `packages/contracts/src/dashboard.ts`
- Create: `apps/api/src/modules/dashboard/application/dashboard-query.service.ts`
- Create: `apps/api/src/modules/dashboard/presentation/admin/dashboard.controller.ts`
- Create: `apps/api/src/modules/dashboard/dashboard.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/src/shared/csv/csv-export.service.ts`
- Modify: `apps/api/src/modules/identity/application/member-admin-query.service.ts`
- Modify: `apps/api/src/modules/identity/presentation/admin/member-admin.controller.ts`
- Modify: `apps/api/src/modules/orders/application/offline-order-query.service.ts`
- Modify: `apps/api/src/modules/orders/presentation/admin/offline-order-admin.controller.ts`
- Modify: `apps/api/src/modules/bookings/application/booking-query.service.ts`
- Modify: `apps/api/src/modules/bookings/presentation/admin/admin-booking.controller.ts`
- Modify: `apps/api/src/modules/activities/application/activity-registration.service.ts`
- Modify: `apps/api/src/modules/activities/presentation/admin/activity-registration-admin.controller.ts`
- Create: `apps/admin-web/src/api/dashboard.ts`
- Create: `apps/admin-web/src/features/dashboard/DashboardView.vue`
- Test: `apps/admin-web/src/features/dashboard/DashboardView.spec.ts`
- Modify: `apps/admin-web/src/router/index.ts`
- Modify: `apps/admin-web/src/layouts/AdminLayout.vue`
- Test: `apps/api/src/shared/csv/csv-export.service.spec.ts`
- Test: `apps/api/test/e2e/dashboard-exports.e2e-spec.ts`

**Interfaces:**
- Produces Shanghai-day metrics for today's sessions, pending attendance, today's bookings, low-balance packages, expiring packages, and active activities, plus four CSV endpoints.

- [ ] **Step 1: Write failing CSV safety tests**

~~~ts
it.each(['=cmd()', '+SUM(1,1)', '-1+1', '@evil'])('neutralizes spreadsheet formula input', (value) => {
  expect(csvCell(value)).toBe("'" + value);
});

it('uses the same filters for list and export and audits the export', async () => {
  const list = await listMembers({ status: 'ACTIVE' });
  const csv = await exportMembers({ status: 'ACTIVE' });
  expect(csv.ids).toEqual(list.items.map((item) => item.id));
  expect(await latestAuditAction()).toBe('MEMBER_EXPORT');
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/shared/csv/csv-export.service.spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/dashboard-exports.e2e-spec.ts
pnpm --filter @member-course/admin-web test -- src/features/dashboard/DashboardView.spec.ts
~~~

Expected: CSV and dashboard services missing.

- [ ] **Step 3: Implement exact endpoints**

~~~text
GET /api/admin/v1/dashboard
GET /api/admin/v1/members/export.csv
GET /api/admin/v1/orders/export.csv
GET /api/admin/v1/class-sessions/:id/roster/export.csv
GET /api/admin/v1/activities/:id/registrations/export.csv
~~~

Use UTF-8 BOM and RFC 4180 quoting, stream large results, prefix risky values with an apostrophe, mask contact values, reuse the list filter DTO, and record an audit event only after successful generation.

`GET /api/admin/v1/dashboard` returns bounded cards for `todaySessions`, `pendingAttendance`, `todayBookings`, `lowBalancePackages`, `expiringPackages`, and `activeActivities`, with IDs and route targets for the corresponding operator queues. Calculate every “today” boundary in `Asia/Shanghai`; do not infer it from the API server timezone.

- [ ] **Step 4: Run tests**

Expected: Shanghai date boundary, today counts, filter parity, quoting, formula protection, masking, and audit tests pass.

Run:

~~~bash
pnpm --filter @member-course/api test -- src/shared/csv/csv-export.service.spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/dashboard-exports.e2e-spec.ts
pnpm --filter @member-course/admin-web test -- src/features/dashboard/DashboardView.spec.ts
~~~

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts/src/dashboard.ts packages/contracts/src/index.ts apps/api/src/app.module.ts apps/api/src/modules/dashboard apps/api/src/shared/csv apps/api/src/modules/identity apps/api/src/modules/orders apps/api/src/modules/bookings apps/api/src/modules/activities apps/admin-web/src/api/dashboard.ts apps/admin-web/src/features/dashboard apps/admin-web/src/router/index.ts apps/admin-web/src/layouts/AdminLayout.vue apps/api/test/e2e/dashboard-exports.e2e-spec.ts
git commit -m "feat(admin): add dashboard and audited csv exports"
~~~

### Task 9: Add Legal Documents and Account Deletion

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/202607230007_account_deletion/migration.sql`
- Create: `packages/contracts/src/legal.ts`
- Create: `apps/api/src/modules/identity/application/legal-document.service.ts`
- Create: `apps/api/src/modules/identity/application/account-deletion.service.ts`
- Create: `apps/api/src/modules/identity/application/account-write-policy.service.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/legal-document-mini.controller.ts`
- Create: `apps/api/src/modules/identity/presentation/mini/account-deletion-mini.controller.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/legal-document-admin.controller.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/account-deletion-admin.controller.ts`
- Modify: `apps/api/src/modules/identity/application/wechat-auth.service.ts`
- Modify: `apps/api/src/modules/identity/application/student-access.service.ts`
- Modify: `apps/api/src/modules/bookings/application/booking-command.service.ts`
- Modify: `apps/api/src/modules/activities/application/activity-registration.service.ts`
- Create: `apps/admin-web/src/api/legal.ts`
- Create: `apps/admin-web/src/features/settings/LegalDocumentView.vue`
- Create: `apps/admin-web/src/features/members/AccountDeletionQueueView.vue`
- Test: `apps/admin-web/src/features/settings/LegalDocumentView.spec.ts`
- Test: `apps/admin-web/src/features/members/AccountDeletionQueueView.spec.ts`
- Modify: `apps/admin-web/src/router/index.ts`
- Modify: `apps/admin-web/src/layouts/AdminLayout.vue`
- Create: `apps/miniapp/miniprogram/services/legal.ts`
- Create: `apps/miniapp/miniprogram/pages/settings/legal.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/settings/account-deletion.{ts,json,wxml,wxss}`
- Test: `apps/miniapp/tests/pages/settings/legal.spec.ts`
- Test: `apps/miniapp/tests/pages/settings/account-deletion.spec.ts`
- Modify: `apps/miniapp/miniprogram/app.json`
- Test: `apps/api/test/integration/identity/account-deletion.integration-spec.ts`
- Test: `apps/api/test/e2e/legal-documents.e2e-spec.ts`

**Interfaces:**
- Produces:

~~~ts
request(accountId: string, ctx: CommandContext): Promise<AccountDeletionResult>;
complete(
  command: { accountId: string; reason: string; idempotencyKey: string },
  ctx: CommandContext,
): Promise<AccountDeletionResult>;
assertCanCreateBusiness(tx: Prisma.TransactionClient, accountId: string): Promise<void>;
~~~

- [ ] **Step 1: Write failing write-block and completion tests**

~~~ts
it('blocks new bookings and registrations but keeps history readable', async () => {
  await requestDeletion(accountId);
  await expect(bookNewSession(accountId)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
  await expect(registerActivity(accountId)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
  expect(await listOrders(accountId)).toHaveLength(1);
});

it('requires all future bookings and registrations to close', async () => {
  await expect(completeDeletion(accountId))
    .rejects.toMatchObject({ code: 'ACCOUNT_DELETION_BLOCKED', details: expect.any(Array) });
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test:integration -- test/integration/identity/account-deletion.integration-spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/legal-documents.e2e-spec.ts
~~~

Expected: deletion models and policy missing.

- [ ] **Step 3: Implement request and completion transaction**

On request, lock the member account and set status `DELETION_PENDING`. Booking and activity registration transactions lock the same account before `assertCanCreateBusiness`, so a concurrent write cannot pass after the request commits. On completion, recheck no active future booking/registration, revoke refresh sessions, detach WeChat identity, clear phone and consent, anonymize direct identity, and retain de-identified order/hour/audit links. Do not reverse orders or packages. A later WeChat registration creates a new account and never auto-links old assets.

- [ ] **Step 4: Add legal/version UI and pass**

Store published versions of user agreement, privacy policy, and phone authorization text. Record which versions the member accepted. Expected: idempotent request/complete, blockers, write policy, history read, anonymization, new registration isolation, and legal version tests pass.

Run:

~~~bash
pnpm --filter @member-course/api test:integration -- test/integration/identity/account-deletion.integration-spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/legal-documents.e2e-spec.ts
pnpm --filter @member-course/admin-web test -- src/features/settings/LegalDocumentView.spec.ts src/features/members/AccountDeletionQueueView.spec.ts
pnpm --filter @member-course/miniapp test -- tests/pages/settings/legal.spec.ts tests/pages/settings/account-deletion.spec.ts
~~~

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/prisma packages/contracts/src/legal.ts packages/contracts/src/index.ts apps/api/src/modules/identity apps/api/src/modules/bookings apps/api/src/modules/activities apps/admin-web/src/api/legal.ts apps/admin-web/src/features/settings/LegalDocumentView.vue apps/admin-web/src/features/settings/LegalDocumentView.spec.ts apps/admin-web/src/features/members/AccountDeletionQueueView.vue apps/admin-web/src/features/members/AccountDeletionQueueView.spec.ts apps/admin-web/src/router/index.ts apps/admin-web/src/layouts/AdminLayout.vue apps/miniapp/miniprogram/services/legal.ts apps/miniapp/miniprogram/pages/settings/legal.* apps/miniapp/miniprogram/pages/settings/account-deletion.* apps/miniapp/miniprogram/app.json apps/miniapp/tests/pages/settings apps/api/test/integration/identity apps/api/test/e2e/legal-documents.e2e-spec.ts
git commit -m "feat(identity): add legal documents and account deletion"
~~~

### Task 10: Add Platform Settings, Administrator Accounts, Media, and Mini Home

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/202607230008_platform_settings/migration.sql`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/contracts/src/settings.ts`
- Create: `packages/contracts/src/media.ts`
- Create: `packages/contracts/src/home.ts`
- Create: `packages/contracts/src/admin-account.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/modules/settings/application/platform-settings.service.ts`
- Create: `apps/api/src/modules/settings/presentation/admin/platform-settings-admin.controller.ts`
- Create: `apps/api/src/modules/settings/settings.module.ts`
- Create: `apps/api/src/modules/media/domain/media-object-status.ts`
- Create: `apps/api/src/modules/media/application/media-upload.service.ts`
- Create: `apps/api/src/modules/media/infrastructure/s3-object-storage.client.ts`
- Create: `apps/api/src/modules/media/presentation/admin/media-admin.controller.ts`
- Create: `apps/api/src/modules/media/media.module.ts`
- Create: `apps/api/src/modules/identity/application/admin-account-management.service.ts`
- Create: `apps/api/src/modules/identity/presentation/admin/admin-account-management.controller.ts`
- Create: `apps/api/src/modules/home/application/mini-home-query.service.ts`
- Create: `apps/api/src/modules/home/presentation/mini/mini-home.controller.ts`
- Create: `apps/api/src/modules/home/home.module.ts`
- Modify: `apps/api/src/modules/notifications/jobs/reminder-planner.job.ts`
- Modify: `apps/api/src/modules/notifications/jobs/package-reminder.job.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/integration/settings/platform-settings.integration-spec.ts`
- Test: `apps/api/test/integration/identity/admin-account-management.integration-spec.ts`
- Test: `apps/api/test/integration/media/media-upload.integration-spec.ts`
- Test: `apps/api/test/e2e/mini-home.e2e-spec.ts`
- Create: `apps/admin-web/src/api/settings.ts`
- Create: `apps/admin-web/src/api/admin-accounts.ts`
- Create: `apps/admin-web/src/api/media.ts`
- Create: `apps/admin-web/src/features/settings/OrganizationSettingsView.vue`
- Create: `apps/admin-web/src/features/settings/AdminAccountView.vue`
- Create: `apps/admin-web/src/features/media/MediaLibraryView.vue`
- Test: `apps/admin-web/src/features/settings/OrganizationSettingsView.spec.ts`
- Test: `apps/admin-web/src/features/settings/AdminAccountView.spec.ts`
- Test: `apps/admin-web/src/features/media/MediaLibraryView.spec.ts`
- Modify: `apps/admin-web/src/router/index.ts`
- Modify: `apps/admin-web/src/layouts/AdminLayout.vue`
- Create: `apps/miniapp/miniprogram/services/home.ts`
- Create: `apps/miniapp/miniprogram/pages/home/index.{ts,json,wxml,wxss}`
- Test: `apps/miniapp/tests/pages/home/index.spec.ts`
- Modify: `apps/miniapp/miniprogram/app.json`
- Modify: `apps/miniapp/miniprogram/custom-tab-bar/index.{ts,json,wxml,wxss}`

**Interfaces:**
- Produces:

~~~ts
getSettings(): Promise<PlatformSettingsDto>;
updateSettings(command: UpdatePlatformSettingsCommand, ctx: CommandContext): Promise<PlatformSettingsDto>;
createAdministrator(command: CreateAdministratorCommand, ctx: CommandContext): Promise<AdministratorDto>;
disableAdministrator(command: DisableAdministratorCommand, ctx: CommandContext): Promise<AdministratorDto>;
createUploadIntent(command: CreateMediaUploadIntentCommand, ctx: CommandContext): Promise<MediaUploadIntentDto>;
completeUpload(command: CompleteMediaUploadCommand, ctx: CommandContext): Promise<MediaObjectDto>;
getMiniHome(accountId: string, studentId?: string): Promise<MiniHomeDto>;
~~~

- [ ] **Step 1: Write failing settings, administrator, media, and home tests**

~~~ts
it('rejects disabling the current or final enabled administrator', async () => {
  await expect(disableAdministrator(currentAdminId)).rejects.toMatchObject({ code: 'ADMIN_CANNOT_DISABLE_SELF' });
  await expect(disableAdministrator(lastOtherAdminId)).rejects.toMatchObject({ code: 'LAST_ADMIN_REQUIRED' });
});

it('marks media ready only after object metadata matches the signed intent', async () => {
  const intent = await createUploadIntent({ mimeType: 'image/png', size: 1024 });
  objectStore.headObject.mockResolvedValue({ contentType: 'image/png', contentLength: 1024, etag: 'etag-1' });
  await expect(completeUpload(intent.mediaId)).resolves.toMatchObject({ status: 'READY' });
});

it('returns only the selected related student home summary', async () => {
  await expect(getHome(unrelatedStudentId)).rejects.toMatchObject({ code: 'STUDENT_FORBIDDEN' });
  await expect(getHome(relatedStudentId)).resolves.toMatchObject({
    nextSessions: expect.any(Array),
    pendingBookings: expect.any(Array),
    hourAlerts: expect.any(Array),
    latestActivities: expect.any(Array),
  });
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test:integration -- test/integration/settings/platform-settings.integration-spec.ts test/integration/identity/admin-account-management.integration-spec.ts test/integration/media/media-upload.integration-spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/mini-home.e2e-spec.ts
pnpm --filter @member-course/admin-web test -- src/features/settings/OrganizationSettingsView.spec.ts src/features/settings/AdminAccountView.spec.ts src/features/media/MediaLibraryView.spec.ts
pnpm --filter @member-course/miniapp test -- tests/pages/home/index.spec.ts
~~~

Expected: platform settings, media, administrator-management, home APIs, and all four UI surfaces are missing.

- [ ] **Step 3: Implement platform settings and administrator safety**

Add a singleton `PlatformSettings` row containing institution name, ready logo media ID, contact details, class/activity/package reminder lead minutes, allowed upload MIME types, maximum upload bytes, and optimistic `version`. Validate nonblank institution name, nonnegative reminder lead times, a bounded positive upload limit, and an explicit MIME allowlist. Every update is audited. Replace the fixed Task 7 reminder defaults with reads from this singleton; a setting change affects only newly planned reminders and does not rewrite already-sent messages.

Expose:

~~~text
GET /api/admin/v1/settings/platform
PUT /api/admin/v1/settings/platform
GET /api/admin/v1/administrators
POST /api/admin/v1/administrators
POST /api/admin/v1/administrators/:id/disable
~~~

New administrators receive an Argon2id password hash and start enabled. Lock all enabled administrator rows in stable ID order before disabling one. Reject disabling the authenticated administrator and reject any transition that would leave zero enabled administrators. Disabled accounts lose active refresh sessions in the same transaction.

- [ ] **Step 4: Implement S3-compatible signed uploads**

Run: `pnpm --filter @member-course/api add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

`MediaObject` stores server-generated object key, MIME type, expected and actual size, ETag, status `PENDING | READY | FAILED | DELETED`, creator, and timestamps. Never accept a client-supplied bucket or object key. `POST /api/admin/v1/media/upload-intents` validates the configured type/size and returns a short-lived signed PUT. `POST /api/admin/v1/media/:id/complete` calls `HeadObject`, compares MIME and length with the intent, and changes to `READY` only on an exact match. `GET /api/admin/v1/media` lists objects; `POST /api/admin/v1/media/:id/delete` marks an unreferenced object deleted and removes it from storage. Logo selection accepts only a ready image.

- [ ] **Step 5: Implement the mini home aggregate and exact UI**

Expose `GET /api/mini/v1/home?studentId=stu_123` with the real selected student ID supplied by the client. Check `StudentAccessService` before all personalized queries. Return the institution header, upcoming class sessions, actionable confirmed bookings, low/expiring course balances, and latest published activities in one bounded response. An unbound account may call `GET /api/mini/v1/home` without `studentId` and receives only institution/public activity data.

Admin pages edit settings, create/disable administrators, upload/browse media, and choose the logo. The mini home page renders the selected student's aggregate and links to course, schedule, activity, and asset pages. Make `首页` the first tab while preserving `课程`, `课表`, `活动`, and `我的`.

- [ ] **Step 6: Run target tests**

Run:

~~~bash
pnpm --filter @member-course/api test:integration -- test/integration/settings/platform-settings.integration-spec.ts test/integration/identity/admin-account-management.integration-spec.ts test/integration/media/media-upload.integration-spec.ts
pnpm --filter @member-course/api test:e2e -- test/e2e/mini-home.e2e-spec.ts
pnpm --filter @member-course/admin-web test -- src/features/settings/OrganizationSettingsView.spec.ts src/features/settings/AdminAccountView.spec.ts src/features/media/MediaLibraryView.spec.ts
pnpm --filter @member-course/miniapp test -- tests/pages/home/index.spec.ts
~~~

Expected: validation, concurrent final-admin protection, session revocation, upload authorization, metadata mismatch, ready-logo enforcement, settings-driven scheduling of new reminders, student isolation, Shanghai date boundaries, empty states, navigation, and loading/error UI tests pass.

- [ ] **Step 7: Commit**

~~~bash
git add apps/api/prisma apps/api/package.json pnpm-lock.yaml packages/contracts/src/settings.ts packages/contracts/src/media.ts packages/contracts/src/home.ts packages/contracts/src/admin-account.ts packages/contracts/src/index.ts apps/api/src/app.module.ts apps/api/src/modules/settings apps/api/src/modules/media apps/api/src/modules/home apps/api/src/modules/notifications/jobs/reminder-planner.job.ts apps/api/src/modules/notifications/jobs/package-reminder.job.ts apps/api/src/modules/identity/application/admin-account-management.service.ts apps/api/src/modules/identity/presentation/admin/admin-account-management.controller.ts apps/api/test/integration/settings apps/api/test/integration/identity/admin-account-management.integration-spec.ts apps/api/test/integration/media apps/api/test/e2e/mini-home.e2e-spec.ts apps/admin-web/src/api/settings.ts apps/admin-web/src/api/admin-accounts.ts apps/admin-web/src/api/media.ts apps/admin-web/src/features/settings/OrganizationSettingsView.vue apps/admin-web/src/features/settings/OrganizationSettingsView.spec.ts apps/admin-web/src/features/settings/AdminAccountView.vue apps/admin-web/src/features/settings/AdminAccountView.spec.ts apps/admin-web/src/features/media apps/admin-web/src/router/index.ts apps/admin-web/src/layouts/AdminLayout.vue apps/miniapp/miniprogram/services/home.ts apps/miniapp/miniprogram/pages/home apps/miniapp/miniprogram/app.json apps/miniapp/miniprogram/custom-tab-bar apps/miniapp/tests/pages/home
git commit -m "feat(platform): add settings media administrators and home"
~~~

### Task 11: Add Health, Metrics, Logging, Rate Limits, Backup, Restore, and Release Checks

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/202607230009_operations_job_run/migration.sql`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/src/platform/observability/health.controller.ts`
- Create: `apps/api/src/platform/observability/metrics.interceptor.ts`
- Create: `apps/api/src/platform/observability/job-run.service.ts`
- Create: `apps/api/src/platform/observability/job-run.cli.ts`
- Create: `apps/api/src/platform/observability/structured-logging.config.ts`
- Create: `apps/api/src/platform/observability/observability.module.ts`
- Create: `apps/api/src/platform/security/rate-limit-key.guard.ts`
- Create: `apps/api/src/platform/security/throttling.module.ts`
- Delete: `apps/api/src/health.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/modules/identity/presentation/admin/admin-auth.controller.ts`
- Modify: `apps/api/src/modules/identity/presentation/mini/mini-auth.controller.ts`
- Modify: `apps/api/src/modules/hours/infrastructure/hour-expiration.job.ts`
- Modify: `apps/api/src/modules/bookings/jobs/booking-settlement.job.ts`
- Modify: `apps/api/src/modules/activities/jobs/activity-settlement.job.ts`
- Modify: `apps/api/src/modules/notifications/jobs/outbox-worker.job.ts`
- Modify: `apps/api/src/modules/notifications/jobs/reminder-planner.job.ts`
- Modify: `apps/api/src/modules/notifications/jobs/package-reminder.job.ts`
- Create: `deploy/prometheus/alerts.yml`
- Create: `scripts/backup-mysql.sh`
- Create: `scripts/verify-mysql-restore.sh`
- Create: `scripts/release-check.sh`
- Create: `scripts/smoke.sh`
- Create: `tests/performance/common-api.js`
- Create: `docs/runbooks/backup-restore.md`
- Create: `docs/runbooks/monitoring.md`
- Create: `docs/runbooks/release.md`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Test: `apps/api/test/e2e/operations.e2e-spec.ts`
- Test: `apps/api/test/e2e/structured-logging.e2e-spec.ts`
- Test: `apps/api/test/e2e/rate-limits.e2e-spec.ts`
- Test: `apps/api/test/integration/operations/job-run.integration-spec.ts`
- Test: `scripts/tests/backup-restore.test.sh`

**Interfaces:**
- Produces: `/health/live`, `/health/ready`, protected `/metrics`, operational scripts, alert rules, and 50-VU performance gate.

- [ ] **Step 1: Write failing readiness and metric tests**

~~~ts
it('reports not ready when MySQL is unavailable', async () => {
  await stopMysql();
  await request(app).get('/health/ready').expect(503);
});

it('increments failed-job and outbox-dead metrics', async () => {
  await recordFailedJob();
  await recordDeadOutbox();
  const metrics = await scrapeMetrics();
  expect(metrics).toContain('member_course_job_failures_total 1');
  expect(metrics).toContain('member_course_outbox_dead_total 1');
});

it('redacts credentials and direct phone data while retaining traceId', async () => {
  await loginWithCapturedLogs({ phone: '13800000000', password: 'secret-value' });
  expect(capturedLogs()).not.toContain('13800000000');
  expect(capturedLogs()).not.toContain('secret-value');
  expect(capturedLogs()).toContain('traceId');
});

it('rate limits repeated login attempts without sharing buckets across principals', async () => {
  await exhaustLoginLimit({ ip: '203.0.113.10', username: 'admin-a' });
  await login({ ip: '203.0.113.10', username: 'admin-a' }).expect(429);
  await login({ ip: '203.0.113.10', username: 'admin-b' }).expect(401);
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test:e2e -- test/e2e/operations.e2e-spec.ts test/e2e/structured-logging.e2e-spec.ts test/e2e/rate-limits.e2e-spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/operations/job-run.integration-spec.ts
bash scripts/tests/backup-restore.test.sh
~~~

Expected: health/metrics endpoints missing.

- [ ] **Step 3: Implement observability, redacted logging, and rate limits**

Run: `pnpm --filter @member-course/api add nestjs-pino pino pino-http prom-client @nestjs/throttler`

Register `ObservabilityModule` and `ThrottlingModule` in `app.module.ts`; delete `apps/api/src/health.controller.ts` after the new routes are active. `/health/live` checks process liveness, `/health/ready` checks MySQL with a bounded timeout, and `/metrics` requires the configured internal bearer token. The metrics interceptor records request count, duration, status class, login failures, outbox backlog/dead rows, and job status without high-cardinality member or object IDs.

Configure Pino JSON logs with the request trace ID and redaction for authorization/cookie headers, refresh/access tokens, passwords, WeChat codes and secrets, complete phone numbers, database credentials, signed-upload query strings, and response `set-cookie`. Tests capture output and assert both redaction and trace correlation.

Install the throttler globally with a bounded default for public/high-frequency reads. Apply stricter named policies to administrator login, WeChat login, and phone binding. `RateLimitKeyGuard` uses trusted proxy-aware client IP plus normalized administrator username for administrator login, and IP plus authenticated account ID where available for mini requests. Return the standard `429` error contract and never include the attempted identifier in logs or metrics.

- [ ] **Step 4: Implement JobRun and scripts with explicit task variables**

`backup-mysql.sh` requires `MEMBER_DB_HOST`, `MEMBER_DB_PORT`, `MEMBER_DB_NAME`, `MEMBER_DB_USER`, `MEMBER_DB_PASSWORD_FILE`, and `MEMBER_BACKUP_DIR`; it writes a timestamped compressed dump and checksum, and exits nonzero on missing variables or `mysqldump` failure. `verify-mysql-restore.sh` creates a named temporary database, restores the dump, checks row counts for account/order/package/hour transaction tables, and drops only that validated temporary database. Neither script prints credentials or accepts a broad filesystem path as a deletion target.

Add `JobRun` with `jobName`, `runId`, `startedAt`, `finishedAt`, `status`, `processedCount`, and masked `errorSummary`. Wrap hour expiration, session settlement, activity settlement, reminder planning, package reminders, and outbox jobs with `JobRunService.run`. `job-run.cli.ts` exposes the same writer to `verify-mysql-restore.sh`, so both successful and failed backup-verification runs are recorded without the shell constructing SQL. Test success, failure, stale-run detection, masked summaries, and rerun identity.

- [ ] **Step 5: Add alerts and performance gate**

Alert on 5xx rate, login failures, outbox backlog/dead rows, scheduled job failure/staleness, database capacity, and missing/failed backup. Run k6 with 50 virtual users and 80/20 read/write mix; exclude WeChat and object-storage latency; fail if common API P95 is at least 500ms.

- [ ] **Step 6: Run operational verification**

~~~bash
pnpm --filter @member-course/api test:e2e -- test/e2e/operations.e2e-spec.ts test/e2e/structured-logging.e2e-spec.ts test/e2e/rate-limits.e2e-spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/operations/job-run.integration-spec.ts
bash scripts/tests/backup-restore.test.sh
bash scripts/release-check.sh
MEMBER_BACKUP_TEST_DIR="$(mktemp -d)"
MEMBER_BACKUP_DIR="$MEMBER_BACKUP_TEST_DIR" bash scripts/backup-mysql.sh
MEMBER_BACKUP_FILE="$(find "$MEMBER_BACKUP_TEST_DIR" -type f -name '*.sql.gz' -print -quit)"
bash scripts/verify-mysql-restore.sh "$MEMBER_BACKUP_FILE"
promtool check rules deploy/prometheus/alerts.yml
bash scripts/smoke.sh http://127.0.0.1:3000
k6 run tests/performance/common-api.js
git diff --check
~~~

Expected: all tests pass, logs contain trace IDs without credentials or complete phones, rate-limit buckets isolate principals, a restored temporary database matches key row counts, alert rules validate, smoke checks pass, and k6 reports `p(95)<500ms`.

- [ ] **Step 7: Commit**

~~~bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/202607230009_operations_job_run apps/api/package.json pnpm-lock.yaml apps/api/src/app.module.ts apps/api/src/main.ts apps/api/src/health.controller.ts apps/api/src/platform/observability apps/api/src/platform/security apps/api/src/modules/identity/presentation/admin/admin-auth.controller.ts apps/api/src/modules/identity/presentation/mini/mini-auth.controller.ts apps/api/src/modules/hours/infrastructure/hour-expiration.job.ts apps/api/src/modules/bookings/jobs/booking-settlement.job.ts apps/api/src/modules/activities/jobs/activity-settlement.job.ts apps/api/src/modules/notifications/jobs/outbox-worker.job.ts apps/api/src/modules/notifications/jobs/reminder-planner.job.ts apps/api/src/modules/notifications/jobs/package-reminder.job.ts deploy/prometheus/alerts.yml scripts/backup-mysql.sh scripts/verify-mysql-restore.sh scripts/release-check.sh scripts/smoke.sh scripts/tests/backup-restore.test.sh tests/performance/common-api.js docs/runbooks/backup-restore.md docs/runbooks/monitoring.md docs/runbooks/release.md .github/workflows/ci.yml .github/workflows/release.yml apps/api/test/e2e/operations.e2e-spec.ts apps/api/test/e2e/structured-logging.e2e-spec.ts apps/api/test/e2e/rate-limits.e2e-spec.ts apps/api/test/integration/operations/job-run.integration-spec.ts
git commit -m "chore(operations): add production readiness checks"
~~~

### Task 12: Verify Final Product and Production Acceptance

**Files:**
- Create: `apps/api/test/e2e/m3-final-product-journey.e2e-spec.ts`
- Create: `apps/api/test/integration/m3-final-concurrency.integration-spec.ts`
- Create: `apps/admin-web/e2e/m3-operations-flow.spec.ts`
- Create: `apps/miniapp/tests/m3-activity-notification-journey.spec.ts`
- Create: `apps/api/src/modules/notifications/cli/wechat-live-verification.ts`
- Create: `scripts/verify-alerts.sh`
- Modify: `apps/api/package.json`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: all M1-M3 functionality.
- Produces: final automated gate plus documented manual/operational evidence checklist.

- [ ] **Step 1: Write the failing full journey**

~~~ts
it('completes activity, notification, audit, and deletion journeys', async () => {
  const activity = await admin.publishHourActivity({ courseId, hours: '1.00', capacity: 1 });
  const registration = await mini.register(studentId, activity.id);
  expect(await packageReserved(packageId)).toBe('1.00');
  await admin.checkInActivity(registration.id);
  expect(await packageConsumed(packageId)).toBe('1.00');
  expect(await notificationFor(registration.id)).toMatchObject({ aggregateVersion: activity.scheduleVersion });
  expect(await auditFor(registration.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'ACTIVITY_REGISTER' }),
    expect.objectContaining({ action: 'ACTIVITY_CHECK_IN' }),
  ]));
});
~~~

- [ ] **Step 2: Add final concurrency and failure assertions**

Cover last activity seat, course/activity overlap, check-in/cancel race, old reminder cancellation, outbox retry/dead/unknown-delivery handling, audit rollback, account-deletion blockers, export formula safety, automatic 30-minute settlement, settings-driven reminder lead times, final-administrator protection, media metadata mismatch, related-student home isolation, log redaction, and principal-isolated rate limits.

- [ ] **Step 3: Run all automated gates**

~~~bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @member-course/api test:integration
pnpm --filter @member-course/api test:e2e
pnpm --filter @member-course/admin-web test:e2e
pnpm --filter @member-course/miniapp test
pnpm build
pnpm --filter @member-course/api prisma validate
git diff --check
~~~

Expected: every M1-M3 suite and command exits 0.

- [ ] **Step 4: Perform required live verification**

`wechat-live-verification.ts` uses the configured test account's real accepted subscription grants, enqueues one uniquely identified message for every enabled template through `NotificationOutboxService`, waits for terminal status, and prints only WeChat message IDs and masked account information. It must refuse production configuration. `verify-alerts.sh` targets only the configured acceptance environment and drives 5xx, outbox backlog/dead, job failure, and backup failure drills described in the monitoring runbook.

Run:

~~~bash
test -n "$MEMBER_ACCEPTANCE_DATABASE_URL"
test -n "$MEMBER_ACCEPTANCE_BASE_URL"
test -n "$MEMBER_WECHAT_TEST_ACCOUNT_ID"
DATABASE_URL="$MEMBER_ACCEPTANCE_DATABASE_URL" pnpm --filter @member-course/api prisma migrate deploy
MEMBER_WECHAT_TEST_ACCOUNT_ID="$MEMBER_WECHAT_TEST_ACCOUNT_ID" pnpm --filter @member-course/api acceptance:wechat
MEMBER_BACKUP_TEST_DIR="$(mktemp -d)"
MEMBER_BACKUP_DIR="$MEMBER_BACKUP_TEST_DIR" bash scripts/backup-mysql.sh
MEMBER_BACKUP_FILE="$(find "$MEMBER_BACKUP_TEST_DIR" -type f -name '*.sql.gz' -print -quit)"
bash scripts/verify-mysql-restore.sh "$MEMBER_BACKUP_FILE"
MEMBER_ACCEPTANCE_BASE_URL="$MEMBER_ACCEPTANCE_BASE_URL" bash scripts/verify-alerts.sh
bash scripts/smoke.sh "$MEMBER_ACCEPTANCE_BASE_URL"
MEMBER_BASE_URL="$MEMBER_ACCEPTANCE_BASE_URL" k6 run tests/performance/common-api.js
~~~

Expected: migration succeeds; WeChat messages arrive once; restore counts match; all alerts fire and clear; P95 is below 500ms; smoke journey passes.

- [ ] **Step 5: Record evidence and commit**

Add exact command output summaries, timestamps, WeChat test message IDs, restore counts, alert screenshots/links, and k6 result to `docs/runbooks/release.md` under a dated release-verification entry.

~~~bash
git add apps/api/test apps/admin-web/e2e apps/miniapp/tests apps/api/src/modules/notifications/cli/wechat-live-verification.ts apps/api/package.json scripts/verify-alerts.sh README.md .github/workflows/ci.yml docs/runbooks/release.md
git commit -m "test: verify complete member course product"
~~~

## Final Completion Gate

The product is complete only when:

1. M1, M2, and M3 automated gates all pass from a clean checkout.
2. Every lesson-hour balance reconciles to append-only package allocations and transactions.
3. Booking and activity capacity/conflict rules survive real MySQL concurrency tests.
4. Notification failures never roll back business state and versioned reminders behave correctly.
5. All administrator, member, and system critical changes are auditable.
6. Account deletion blocks writes, preserves de-identified history, and does not relink later accounts.
7. Institution settings, administrator safety, S3-compatible media, and the personalized mini home pass API and UI acceptance.
8. Pino logs are structured and redacted, and login, phone binding, and high-frequency query limits return the standard `429` contract without cross-principal buckets.
9. Real WeChat messaging, backup restore, alerts, 50-user performance, health checks, and smoke journey are evidenced.
10. `git status --short` is empty and no production secret is tracked.
