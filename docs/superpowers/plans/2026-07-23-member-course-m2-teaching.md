# M2 Teaching, Booking, and Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend a completed M1 system with teacher/classroom resources, class and one-to-one scheduling, rule-snapshot booking, cancellation, attendance settlement, traceable corrections, and the complete admin/mini-program teaching journey.

**Architecture:** Add `scheduling` and `bookings` modules to the existing NestJS modular monolith. Every booking and attendance command runs in a MySQL transaction, uses the M1 lesson-hour ledger rather than editing balances, and follows a fixed lock order. Published sessions carry immutable policy snapshots; M3 can later consume the versioned session events without changing M2 behavior.

**Tech Stack:** Existing M1 stack, including the NestJS Scheduler installed in M1 Task 10, plus Prisma/MySQL row locks, Vitest fake timers, Testcontainers MySQL, Vue 3 admin scheduling views, and native WeChat mini-program timetable pages.

## Global Constraints

- Repository: `https://github.com/Broccoli-X/member-course-miniapp.git`.
- Prerequisite: every M1 completion-gate assertion passes on the same branch.
- Keep one institution and one campus; teacher and classroom names need no tenant/campus keys.
- Course types remain `CLASS` and `ONE_TO_ONE`.
- Class groups are batch-scheduling templates, not fixed enrolment rosters, and never auto-book a term.
- A published session stores both source policy version ID and immutable policy JSON; settlement never reads a newer course policy.
- A one-to-one session has capacity exactly 1.
- Booking-time deduction consumes available hours immediately. Attendance-time deduction reserves at booking and consumes at check-in/no-show according to policy.
- Session-date eligibility uses inclusive package business dates in `Asia/Shanghai`.
- A related package that has expired by reversal time receives returned units into its expired bucket, never available.
- User cancellation is allowed before session start; equal to the deadline is on time, later is a late cancellation.
- Closed bookings remain immutable. A later rebooking creates a new attempt and at most one active attempt exists.
- Session completion occurs manually after end time or automatically at end time plus 30 minutes.
- M2 does not implement activities, WeChat notifications, production audit views, or account deletion.
- Every concurrency test uses real MySQL, not mocks or SQLite.

---

## Locked M2 File Map

~~~text
apps/api/src/modules/scheduling/
  domain/session-policy.ts
  application/teaching-resource.service.ts
  application/class-group.service.ts
  application/session-command.service.ts
  application/session-query.service.ts
  infrastructure/session-lock.repository.ts
  presentation/admin/
apps/api/src/modules/bookings/
  domain/booking-state.ts
  domain/attendance-transition.ts
  application/booking-command.service.ts
  application/booking-query.service.ts
  application/attendance-command.service.ts
  application/student-schedule-conflict.service.ts
  application/student-schedule-occupancy.provider.ts
  application/published-session-command.service.ts
  application/auto-settlement.service.ts
  infrastructure/booking-lock.repository.ts
  jobs/booking-settlement.job.ts
  presentation/admin/
  presentation/mini/
packages/contracts/src/scheduling.ts
packages/contracts/src/bookings.ts
apps/admin-web/src/features/teaching/
apps/miniapp/miniprogram/pages/schedule/
apps/miniapp/miniprogram/pages/session/
apps/miniapp/miniprogram/pages/bookings/
~~~

M2 publishes these interfaces for M3:

~~~ts
export interface SessionScheduleChanged {
  domainEventId: string;
  sessionId: string;
  priorScheduleVersion: number;
  scheduleVersion: number;
  oldStartAt: string;
  oldEndAt: string;
  newStartAt: string;
  newEndAt: string;
  affectedAccountIds: string[];
}

export interface SessionCancelled {
  domainEventId: string;
  sessionId: string;
  scheduleVersion: number;
  affectedAccountIds: string[];
}

export interface StudentScheduleOccupancyProvider {
  findOverlaps(
    tx: Prisma.TransactionClient,
    input: { studentId: string; startAt: Date; endAt: Date; excludeSourceId?: string },
  ): Promise<Array<{ sourceType: 'BOOKING' | 'ACTIVITY'; sourceId: string }>>;
}
~~~

`StudentScheduleOccupancyProvider` is defined in
`apps/api/src/modules/bookings/application/student-schedule-occupancy.provider.ts`
because it depends on Prisma. `MemberOrAdminCommandContext` is defined in
`apps/api/src/common/commands/member-or-admin-command-context.ts` and extends the M1
`CommandContext` with `memberAccountId: string | null`.

### Task 1: Add Teaching, Session, Booking, and Attendance Persistence

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/202607230002_m2_teaching/migration.sql`
- Create: `packages/contracts/src/scheduling.ts`
- Create: `packages/contracts/src/bookings.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/test/integration/prisma/m2-schema.integration-spec.ts`

**Interfaces:**
- Consumes: M1 course, student, package, hour transaction, and allocation models.
- Produces: `CoursePolicyVersion`, `Teacher`, `Classroom`, `ClassGroup`, `ClassSession`, `Booking`, `AttendanceRecord`, and `ScheduledJobLease`.

- [ ] **Step 1: Write failing database-constraint tests**

~~~ts
it('allows multiple closed attempts but one active booking', async () => {
  await createClosedBooking({ studentId, sessionId, attemptNo: 1 });
  await createClosedBooking({ studentId, sessionId, attemptNo: 2 });
  await createActiveBooking({ studentId, sessionId, attemptNo: 3, activeKey: studentId + ':' + sessionId });
  await expect(createActiveBooking({ studentId, sessionId, attemptNo: 4, activeKey: studentId + ':' + sessionId }))
    .rejects.toMatchObject({ code: 'P2002' });
});

it('rejects an invalid session interval and one-to-one capacity', async () => {
  await expect(createSession({ startAt, endAt: startAt })).rejects.toBeDefined();
  await expect(createOneToOneSession({ capacity: 2 })).rejects.toBeDefined();
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test:integration -- test/integration/prisma/m2-schema.integration-spec.ts`

Expected: FAIL because M2 models do not exist.

- [ ] **Step 3: Add exact persistence invariants**

~~~text
CoursePolicyVersion: courseId, version(unique per course), requiredHours Decimal(10,2),
  deductAt(BOOKING|ATTENDANCE), bookingOpenMinutesBefore, bookingCloseMinutesBefore,
  cancelDeadlineMinutesBefore, lateCancelDeduct, noShowDeduct, createdAt
Teacher/Classroom: name, status, createdAt, updatedAt, version
ClassGroup: courseId, name, defaultTeacherId, defaultClassroomId, defaultCapacity, status, version
ClassSession: courseId, classGroupId(nullable), teacherId, classroomId, type, startAt, endAt,
  capacity, status, policyVersionId(nullable until publish), policySnapshot Json(nullable until publish),
  bookingOpenAt(nullable until publish), bookingCloseAt(nullable until publish),
  cancelDeadlineAt(nullable until publish), scheduleVersion, createdAt, updatedAt, version
Booking: sessionId, studentId, attemptNo, activeKey(unique nullable), status,
  initialHourTransactionId, currentAttendanceRecordId, createdByActorType, createdAt, updatedAt, version
AttendanceRecord: bookingId, status, supersedesId(nullable), reason, actorType, actorId, createdAt
ScheduledJobLease: jobName(unique), ownerId, leasedUntil, updatedAt
~~~

Add unique `(sessionId, studentId, attemptNo)`, interval CHECK, one-to-one capacity CHECK, and indexes for resource overlap, student overlap, booking roster, and due-session scans. Use nullable `activeKey` because MySQL permits multiple nulls. Draft sessions may keep the policy reference, snapshot, and three derived window timestamps null; `publishMany` must atomically populate all five fields before changing the state to `PUBLISHED`.

- [ ] **Step 4: Validate and rerun**

~~~bash
pnpm --filter @member-course/api prisma generate
pnpm --filter @member-course/api prisma validate
pnpm --filter @member-course/api test:integration -- test/integration/prisma/m2-schema.integration-spec.ts
~~~

Expected: all constraints pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/prisma packages/contracts apps/api/test/integration/prisma/m2-schema.integration-spec.ts
git commit -m "feat(api): add teaching and booking schema"
~~~

### Task 2: Manage Teachers, Classrooms, and Class Groups

**Files:**
- Create: `apps/api/src/modules/scheduling/scheduling.module.ts`
- Create: `apps/api/src/modules/scheduling/application/teaching-resource.service.ts`
- Create: `apps/api/src/modules/scheduling/application/class-group.service.ts`
- Create: `apps/api/src/modules/scheduling/infrastructure/teaching-resource.repository.ts`
- Create: `apps/api/src/modules/scheduling/presentation/admin/teaching-resource.controller.ts`
- Create: `apps/api/src/modules/scheduling/presentation/admin/class-group.controller.ts`
- Test: `apps/api/src/modules/scheduling/application/teaching-resource.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/contracts/src/scheduling.ts`

**Interfaces:**
- Produces: resource CRUD and version-checked status changes.

~~~ts
createTeacher(command: CreateTeacherCommand, ctx: CommandContext): Promise<TeacherDto>;
setTeacherStatus(id: string, status: ResourceStatus, expectedVersion: number, ctx: CommandContext): Promise<TeacherDto>;
createClassroom(command: CreateClassroomCommand, ctx: CommandContext): Promise<ClassroomDto>;
createClassGroup(command: CreateClassGroupCommand, ctx: CommandContext): Promise<ClassGroupDto>;
archiveClassGroup(id: string, expectedVersion: number, ctx: CommandContext): Promise<ClassGroupDto>;
~~~

- [ ] **Step 1: Write failing lifecycle tests**

~~~ts
it('archives a referenced teacher instead of deleting it', async () => {
  const teacher = await seedTeacherWithSession();
  await service.setTeacherStatus(teacher.id, 'ARCHIVED', teacher.version, adminContext);
  expect(await findTeacher(teacher.id)).toMatchObject({ status: 'ARCHIVED' });
  expect(await sessionCountForTeacher(teacher.id)).toBe(1);
});

it('does not create enrolments when a class group is created', async () => {
  const group = await service.createClassGroup(command, adminContext);
  expect(await bookingCountForGroup(group.id)).toBe(0);
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/api test -- src/modules/scheduling/application/teaching-resource.service.spec.ts`

Expected: missing scheduling services.

- [ ] **Step 3: Implement resource routes**

~~~text
GET/POST/PATCH /api/admin/v1/teachers
GET/POST/PATCH /api/admin/v1/classrooms
GET/POST/PATCH /api/admin/v1/class-groups
POST           /api/admin/v1/teachers/:id/status
POST           /api/admin/v1/classrooms/:id/status
POST           /api/admin/v1/class-groups/:id/archive
~~~

Reject stale `expectedVersion` with `STATE_CHANGED`. Referenced resources remain readable and can only be disabled or archived.

- [ ] **Step 4: Run target tests**

Run: `pnpm --filter @member-course/api test -- src/modules/scheduling/application/teaching-resource.service.spec.ts`

Expected: CRUD, version conflicts, archive behavior, and “no implicit enrolment” tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/scheduling apps/api/src/app.module.ts packages/contracts/src/scheduling.ts
git commit -m "feat(api): manage teaching resources"
~~~

### Task 3: Extend the Lesson-Hour Ledger for Booking Allocations

**Files:**
- Modify: `apps/api/src/modules/hours/application/hour-ledger.service.ts`
- Create: `apps/api/src/modules/hours/application/hour-ledger.types.ts`
- Modify: `apps/api/src/modules/hours/infrastructure/hour-lock.repository.ts`
- Test: `apps/api/test/integration/hours/booking-hour-ledger.integration-spec.ts`

**Interfaces:**
- Produces transaction-internal allocation and reversal operations:

~~~ts
export interface AllocateHoursInput {
  studentId: string;
  courseId: string;
  units: DecimalString;
  serviceAt: Date;
  sourceType: 'BOOKING' | 'ACTIVITY';
  sourceId: string;
  businessKey: string;
  occurredAt: Date;
}

export interface TransitionAllocatedHoursInput {
  originalTransactionId: string;
  sourceType: 'BOOKING' | 'ACTIVITY';
  sourceId: string;
  businessKey: string;
  occurredAt: Date;
}

consumeAvailable(tx: Prisma.TransactionClient, input: AllocateHoursInput): Promise<HourPostingResult>;
reserve(tx: Prisma.TransactionClient, input: AllocateHoursInput): Promise<HourPostingResult>;
consumeReserved(tx: Prisma.TransactionClient, input: TransitionAllocatedHoursInput): Promise<HourPostingResult>;
releaseReserved(tx: Prisma.TransactionClient, input: TransitionAllocatedHoursInput): Promise<HourPostingResult>;
refundConsumed(tx: Prisma.TransactionClient, input: TransitionAllocatedHoursInput): Promise<HourPostingResult>;
restoreReserved(tx: Prisma.TransactionClient, input: TransitionAllocatedHoursInput): Promise<HourPostingResult>;
reconsumeReturned(tx: Prisma.TransactionClient, input: TransitionAllocatedHoursInput): Promise<HourPostingResult>;
~~~

- [ ] **Step 1: Write failing allocation-transition tests**

~~~ts
it('selects only packages covering the service date', async () => {
  await seedPackage({ expiresOn: '2026-08-01', available: '2.00' });
  await seedPackage({ expiresOn: '2026-09-01', available: '2.00' });
  const result = await reserveHours({ units: '2.00', serviceAt: '2026-08-15T02:00:00Z' });
  expect(result.allocations).toEqual([expect.objectContaining({ packageExpiresOn: '2026-09-01', units: '2.00' })]);
});

it('returns released units to expired when the original package has expired', async () => {
  const posting = await reserveBeforeExpiry();
  await releaseAfterExpiry(posting.transactionId);
  expect(await packageBuckets(posting.packageId)).toMatchObject({ available: '0.00', expired: '2.00' });
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/hours
pnpm --filter @member-course/api test:integration -- test/integration/hours/booking-hour-ledger.integration-spec.ts
~~~

Expected: missing `reserve` and transition methods.

- [ ] **Step 3: Implement source-preserving transitions**

Reversal methods follow the `originalTransactionId` and its original `HourAllocation` rows instead of rerunning FEFO. Never create negative buckets. Use the same balance/package lock order as M1 expiry.

- [ ] **Step 4: Run unit and integration tests**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/hours
pnpm --filter @member-course/api test:integration -- test/integration/hours/booking-hour-ledger.integration-spec.ts
~~~

Expected: date coverage, FEFO, business-key idempotency, reserved-to-consumed, valid release, expired release, correction reversal, and concurrent final-hour tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/hours apps/api/test/integration/hours
git commit -m "feat(api): support booking hour allocations"
~~~

### Task 4: Publish Class Batches and One-to-One Slots with Policy Snapshots

**Files:**
- Create: `apps/api/src/modules/scheduling/domain/session-policy.ts`
- Create: `apps/api/src/modules/scheduling/application/course-policy.service.ts`
- Create: `apps/api/src/modules/scheduling/application/session-command.service.ts`
- Create: `apps/api/src/modules/scheduling/application/session-query.service.ts`
- Create: `apps/api/src/modules/scheduling/infrastructure/session-lock.repository.ts`
- Create: `apps/api/src/modules/scheduling/presentation/admin/course-policy.controller.ts`
- Create: `apps/api/src/modules/scheduling/presentation/admin/class-session.controller.ts`
- Test: `apps/api/src/modules/scheduling/application/course-policy.service.spec.ts`
- Test: `apps/api/src/modules/scheduling/application/session-command.service.spec.ts`
- Test: `apps/api/test/integration/scheduling/session-conflict.integration-spec.ts`
- Modify: `packages/contracts/src/scheduling.ts`

**Interfaces:**
- Produces:

~~~ts
createClassBatch(command: CreateClassBatchCommand, ctx: CommandContext): Promise<ClassSessionDto[]>;
createOneToOneSlots(command: CreateOneToOneSlotsCommand, ctx: CommandContext): Promise<ClassSessionDto[]>;
publishMany(command: PublishSessionsCommand, ctx: CommandContext): Promise<ClassSessionDto[]>;
createPolicyVersion(command: CreateCoursePolicyVersionCommand, ctx: CommandContext): Promise<CoursePolicyVersionDto>;
~~~

- [ ] **Step 1: Write failing snapshot and overlap tests**

~~~ts
it('keeps the published policy after the course policy changes', async () => {
  const session = await createAndPublishSession(policyV1);
  await createPolicyVersion(policyV2);
  expect((await findSession(session.id)).policySnapshot).toEqual(policyV1);
});

it('requires positive hours and valid booking windows in a policy version', async () => {
  await expect(createPolicy({ requiredHours: '0.00' }))
    .rejects.toMatchObject({ code: 'HOURS_MUST_BE_POSITIVE' });
  await expect(createPolicy({ bookingOpenMinutesBefore: 60, bookingCloseMinutesBefore: 120 }))
    .rejects.toMatchObject({ code: 'BOOKING_WINDOW_INVALID' });
});

it('allows only one concurrent publication for an overlapping teacher', async () => {
  const results = await Promise.allSettled([publish(sessionA), publish(sessionB)]);
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((item) => item.status === 'rejected')[0])
    .toMatchObject({ reason: expect.objectContaining({ code: 'TEACHER_TIME_CONFLICT' }) });
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/scheduling/application/course-policy.service.spec.ts src/modules/scheduling/application/session-command.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/scheduling/session-conflict.integration-spec.ts
~~~

Expected: missing session services.

- [ ] **Step 3: Implement fixed lock and overlap rules**

For each publication transaction, lock all teachers ordered by ID, then all classrooms ordered by ID. Requery overlap using `existing.startAt < newEnd && existing.endAt > newStart`; adjacent sessions are allowed. Check conflicts inside the new batch. Copy the current policy into JSON and calculate UTC booking-open, booking-close, and cancellation-deadline instants.

- [ ] **Step 4: Implement exact routes and pass tests**

~~~text
GET  /api/admin/v1/class-sessions
GET/POST /api/admin/v1/courses/:courseId/policies
POST /api/admin/v1/class-sessions/class-batches
POST /api/admin/v1/class-sessions/one-to-one-slots
POST /api/admin/v1/class-sessions/publish
~~~

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/scheduling/application/course-policy.service.spec.ts src/modules/scheduling/application/session-command.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/scheduling/session-conflict.integration-spec.ts
~~~

Expected: batch generation, one-to-one capacity, adjacency, internal conflict, concurrent conflict, and snapshot immutability tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/scheduling apps/api/test/integration/scheduling packages/contracts/src/scheduling.ts
git commit -m "feat(api): publish class and one-to-one sessions"
~~~

### Task 5: Implement Booking, Cancellation, Capacity, and Student Conflicts

**Files:**
- Create: `apps/api/src/modules/bookings/bookings.module.ts`
- Create: `apps/api/src/modules/bookings/domain/booking-state.ts`
- Create: `apps/api/src/modules/bookings/application/booking-command.service.ts`
- Create: `apps/api/src/modules/bookings/application/booking-query.service.ts`
- Create: `apps/api/src/modules/bookings/application/student-schedule-conflict.service.ts`
- Create: `apps/api/src/modules/bookings/application/student-schedule-occupancy.provider.ts`
- Create: `apps/api/src/modules/bookings/infrastructure/booking-lock.repository.ts`
- Create: `apps/api/src/modules/bookings/presentation/mini/mini-booking.controller.ts`
- Create: `apps/api/src/modules/bookings/presentation/admin/admin-booking.controller.ts`
- Create: `apps/api/src/common/commands/member-or-admin-command-context.ts`
- Test: `apps/api/src/modules/bookings/application/booking-command.service.spec.ts`
- Test: `apps/api/test/integration/bookings/booking-concurrency.integration-spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/contracts/src/scheduling.ts`
- Modify: `packages/contracts/src/bookings.ts`

**Interfaces:**
- Consumes: `StudentAccessService`, session snapshot, and Task 3 ledger methods.
- Produces:

~~~ts
book(command: BookSessionCommand, ctx: MemberOrAdminCommandContext): Promise<BookingDto>;
cancel(command: CancelBookingCommand, ctx: MemberOrAdminCommandContext): Promise<BookingDto>;
assertNoOverlap(
  tx: Prisma.TransactionClient,
  input: { studentId: string; startAt: Date; endAt: Date; excludeSourceId?: string },
): Promise<void>;
~~~

- [ ] **Step 1: Write failing boundary and race tests**

~~~ts
it.each([
  ['2026-07-23T01:00:00.000Z', 'CANCELLED_ON_TIME'],
  ['2026-07-23T01:00:00.001Z', 'CANCELLED_LATE'],
])('classifies cancellation at the exact deadline', async (now, status) => {
  expect((await cancelAt(now)).status).toBe(status);
});

it('permits one winner for the last seat and one for overlapping sessions', async () => {
  expect(await concurrentLastSeatResults()).toEqual(['CONFIRMED', 'SESSION_FULL']);
  expect(await concurrentStudentOverlapResults()).toEqual(['CONFIRMED', 'TIME_CONFLICT']);
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/bookings/application/booking-command.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/bookings/booking-concurrency.integration-spec.ts
~~~

Expected: missing booking module.

- [ ] **Step 3: Implement fixed transaction order**

Lock `StudentProfile → ClassSession → StudentCourseBalance → CoursePackage`. After locks, recheck member relation, account write permission, session status/window, active overlap, capacity, and hours. Use `consumeAvailable` for booking-time deduction or `reserve` for attendance-time deduction.

Cancellation before start is always accepted and classified against the snapshot deadline. Apply refund/release/consume according to `lateCancelDeduct`. Clear old `activeKey`. A rebooking creates `attemptNo + 1` and never changes old postings.

- [ ] **Step 4: Implement exact routes and pass**

~~~text
GET  /api/admin/v1/class-sessions/:id/bookings
POST /api/admin/v1/students/:studentId/bookings
POST /api/admin/v1/bookings/:id/cancel
GET  /api/mini/v1/students/:studentId/sessions
GET  /api/mini/v1/students/:studentId/bookings
POST /api/mini/v1/students/:studentId/bookings
POST /api/mini/v1/bookings/:id/cancel
~~~

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/bookings/application/booking-command.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/bookings/booking-concurrency.integration-spec.ts
~~~

Expected: window, relation, capacity, overlap, hour mode, cancellation, rebooking, and idempotency tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/bookings apps/api/src/common/commands/member-or-admin-command-context.ts apps/api/src/app.module.ts apps/api/test/integration/bookings packages/contracts/src/scheduling.ts packages/contracts/src/bookings.ts
git commit -m "feat(api): support session booking and cancellation"
~~~

### Task 6: Settle Attendance and Append Traceable Corrections

**Files:**
- Create: `apps/api/src/modules/bookings/domain/attendance-transition.ts`
- Create: `apps/api/src/modules/bookings/application/attendance-command.service.ts`
- Create: `apps/api/src/modules/bookings/presentation/admin/attendance.controller.ts`
- Test: `apps/api/src/modules/bookings/application/attendance-command.service.spec.ts`
- Test: `apps/api/test/integration/bookings/attendance-concurrency.integration-spec.ts`
- Modify: `packages/contracts/src/bookings.ts`

**Interfaces:**
- Produces:

~~~ts
checkIn(command: SettleAttendanceCommand, ctx: CommandContext): Promise<BookingDto>;
markNoShow(command: SettleAttendanceCommand, ctx: CommandContext): Promise<BookingDto>;
correct(command: CorrectAttendanceCommand, ctx: CommandContext): Promise<BookingDto>;
~~~

- [ ] **Step 1: Write failing policy-mode tests**

~~~ts
it('does not post hours when checking in a booking-time deduction', async () => {
  const booking = await seedBookingTimeDeductedBooking();
  const before = await transactionCount(booking.id);
  await service.checkIn(commandFor(booking), adminContext);
  expect(await transactionCount(booking.id)).toBe(before);
});

it('changes reserved to consumed for attendance-time deduction', async () => {
  const booking = await seedReservedBooking();
  await service.checkIn(commandFor(booking), adminContext);
  expect(await bookingAllocationBuckets(booking.id)).toMatchObject({ reserved: '0.00', consumed: '1.00' });
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/bookings/application/attendance-command.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/bookings/attendance-concurrency.integration-spec.ts
~~~

Expected: missing attendance service.

- [ ] **Step 3: Implement correction records**

`CorrectAttendanceCommand.target` is `CHECKED_IN | NO_SHOW | UNSETTLED` and requires `reason` plus `expectedVersion`. Add a new `AttendanceRecord` with `supersedesId`; never delete old records. Reverse only postings actually caused by the old attendance transition. A booking-time check-in creates no hour posting, so undoing it never refunds hours.

- [ ] **Step 4: Run target tests**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/bookings/application/attendance-command.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/bookings/attendance-concurrency.integration-spec.ts
~~~

Expected: check-in, paid/free no-show, expired return, correction chain, no false refund, and cancel-versus-check-in race tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/bookings apps/api/test/integration/bookings packages/contracts/src/bookings.ts
git commit -m "feat(api): settle and correct attendance"
~~~

### Task 7: Orchestrate Reschedule or Institution-Cancel Published Sessions

**Files:**
- Modify: `apps/api/src/modules/scheduling/application/session-command.service.ts`
- Create: `apps/api/src/modules/scheduling/application/session-event.types.ts`
- Modify: `apps/api/src/modules/scheduling/scheduling.module.ts`
- Create: `apps/api/src/modules/bookings/application/published-session-command.service.ts`
- Create: `apps/api/src/modules/bookings/presentation/admin/published-session.controller.ts`
- Modify: `apps/api/src/modules/bookings/bookings.module.ts`
- Modify: `apps/api/src/modules/bookings/application/student-schedule-conflict.service.ts`
- Test: `apps/api/src/modules/bookings/application/published-session-command.service.spec.ts`
- Test: `apps/api/test/integration/scheduling/session-change.integration-spec.ts`
- Modify: `packages/contracts/src/scheduling.ts`

**Interfaces:**
- `PublishedSessionCommandService` is the cross-module transaction boundary. It consumes transaction-internal session mutation operations exported by `SchedulingModule`, booking closure, student conflict, and hour-ledger operations. `SchedulingModule` never imports `BookingsModule`.
- Produces versioned `SessionScheduleChanged` and `SessionCancelled` events from this service for M3 notification and audit wiring.

~~~ts
reschedule(command: RescheduleSessionCommand, ctx: CommandContext): Promise<{
  session: ClassSessionDto;
  event: SessionScheduleChanged;
}>;

cancel(command: CancelSessionCommand, ctx: CommandContext): Promise<{
  session: ClassSessionDto;
  event: SessionCancelled;
}>;
~~~

- [ ] **Step 1: Write failing reschedule and cancel tests**

~~~ts
it('rejects rescheduling beyond an allocated package expiry', async () => {
  const fixture = await bookedSessionWithPackageEnding('2026-08-31');
  await expect(reschedule(fixture.sessionId, '2026-09-01T02:00:00Z'))
    .rejects.toMatchObject({ code: 'PACKAGE_NOT_VALID_FOR_SESSION' });
});

it('returns every confirmed booking allocation on institution cancel', async () => {
  const fixture = await bookedSession();
  await cancelSession(fixture.sessionId);
  expect(await bookingStatus(fixture.bookingId)).toBe('SESSION_CANCELLED');
  expect(await packageAvailable(fixture.packageId)).toBe(fixture.originalAvailable);
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/bookings/application/published-session-command.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/scheduling/session-change.integration-spec.ts
~~~

Expected: the published-session orchestration service and routes are missing.

- [ ] **Step 3: Implement revalidation and events**

Perform an unlocked preliminary read only to collect resource and affected-student IDs. Inside the transaction, lock `StudentProfile` rows sorted by ID, then `Teacher` rows sorted by ID, `Classroom` rows sorted by ID, `ClassSession`, `StudentCourseBalance` rows sorted by ID, and `CoursePackage` rows in the M1 FEFO/ID order. Re-read the session version, active bookings, overlaps, and allocations after the locks. This extends Task 5's student-before-session order and prevents cancellation/check-in/reschedule deadlocks.

Recheck teacher/classroom and each student overlap. Every original allocation must cover the new date; do not silently switch packages. On cancel, close every active booking and unconditionally reverse its original allocation; expired packages receive expired units. Increment `scheduleVersion`. `SessionCommandService` exposes only transaction-internal mutation primitives; the public `reschedule` and `cancel` methods and both HTTP commands belong to `PublishedSessionCommandService`.

Expose `POST /api/admin/v1/class-sessions/:id/reschedule` and `POST /api/admin/v1/class-sessions/:id/cancel`. Both require `Idempotency-Key`, `expectedVersion`, and an administrator reason.

- [ ] **Step 4: Run target tests**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/bookings/application/published-session-command.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/scheduling/session-change.integration-spec.ts
~~~

Expected: conflict, validity, all-or-nothing rollback, cancel return, expired return, and event-version tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/scheduling apps/api/src/modules/bookings apps/api/test/integration/scheduling packages/contracts/src/scheduling.ts
git commit -m "feat(api): reschedule and cancel sessions"
~~~

### Task 8: Auto-Settle Sessions 30 Minutes After End

**Files:**
- Create: `apps/api/src/platform/jobs/infrastructure/job-lease.service.ts`
- Create: `apps/api/src/modules/bookings/application/auto-settlement.service.ts`
- Create: `apps/api/src/modules/bookings/jobs/booking-settlement.job.ts`
- Create: `apps/api/src/modules/bookings/presentation/admin/session-settlement.controller.ts`
- Test: `apps/api/src/modules/bookings/application/auto-settlement.service.spec.ts`
- Test: `apps/api/test/integration/bookings/auto-settlement.integration-spec.ts`
- Modify: `apps/api/src/modules/bookings/bookings.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/contracts/src/bookings.ts`

**Interfaces:**
- Produces:

~~~ts
settleSession(command: SettleSessionCommand, ctx: CommandContext): Promise<SessionSettlementResult>;
settleDueSessions(now: Date, batchSize: number): Promise<SettlementBatchResult>;
~~~

- [ ] **Step 1: Write failing clock-boundary tests**

~~~ts
it('does not settle at 29:59 and settles at 30:00', async () => {
  await service.settleDueSessions(add(endAt, { minutes: 29, seconds: 59 }), 100);
  expect(await bookingStatus(bookingId)).toBe('CONFIRMED');
  await service.settleDueSessions(add(endAt, { minutes: 30 }), 100);
  expect(await bookingStatus(bookingId)).toBe('NO_SHOW');
});

it('does not double-post when manual and automatic settlement race', async () => {
  await Promise.allSettled([manualSettle(sessionId), autoSettle(sessionId)]);
  expect(await settlementTransactionCount(bookingId)).toBe(1);
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/bookings/application/auto-settlement.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/bookings/auto-settlement.integration-spec.ts
~~~

Expected: missing settlement service.

- [ ] **Step 3: Implement leased polling**

Consume the `@nestjs/schedule` dependency and the single root `ScheduleModule.forRoot()` registration supplied by M1 Task 10; do not reinstall the package or register another scheduler root. Update `AppModule` to wire the completed `BookingsModule`, and register `JobLeaseService`, `AutoSettlementService`, `BookingSettlementJob`, and `SessionSettlementController` in `BookingsModule`.

Run the booking settlement job every 5 minutes. Claim a `ScheduledJobLease`, scan `PUBLISHED` sessions with `endAt <= now - 30 minutes`, and call the same internal no-show command with key `session-auto-settle:<bookingId>:<scheduleVersion>`. Complete the session when no `CONFIRMED` bookings remain; complete empty sessions too.

- [ ] **Step 4: Run target tests**

Run:

~~~bash
pnpm --filter @member-course/api test -- src/modules/bookings/application/auto-settlement.service.spec.ts
pnpm --filter @member-course/api test:integration -- test/integration/bookings/auto-settlement.integration-spec.ts
~~~

Expected: 29:59, 30:00, rerun, manual race, empty session, lease expiry, and interrupted-batch resume tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/platform apps/api/src/modules/bookings apps/api/src/app.module.ts apps/api/test/integration/bookings packages/contracts/src/bookings.ts
git commit -m "feat(api): auto-settle ended sessions"
~~~

### Task 9: Build the Admin Teaching and Attendance Workspace

**Files:**
- Create: `apps/admin-web/src/api/scheduling.ts`
- Create: `apps/admin-web/src/api/bookings.ts`
- Create: `apps/admin-web/src/features/teaching/TeachingResourcesView.vue`
- Create: `apps/admin-web/src/features/teaching/ClassGroupsView.vue`
- Create: `apps/admin-web/src/features/teaching/ScheduleView.vue`
- Create: `apps/admin-web/src/features/teaching/AttendanceView.vue`
- Create: `apps/admin-web/src/features/teaching/CoursePolicyForm.vue`
- Create: `apps/admin-web/src/features/teaching/ClassBatchDialog.vue`
- Create: `apps/admin-web/src/features/teaching/OneToOneSlotsDialog.vue`
- Create: `apps/admin-web/src/features/teaching/SessionRosterDrawer.vue`
- Test: `apps/admin-web/src/features/teaching/TeachingResourcesView.spec.ts`
- Test: `apps/admin-web/src/features/teaching/ClassGroupsView.spec.ts`
- Test: `apps/admin-web/src/features/teaching/ScheduleView.spec.ts`
- Test: `apps/admin-web/src/features/teaching/AttendanceView.spec.ts`
- Test: `apps/admin-web/src/features/teaching/CoursePolicyForm.spec.ts`
- Test: `apps/admin-web/src/features/teaching/ClassBatchDialog.spec.ts`
- Test: `apps/admin-web/src/features/teaching/OneToOneSlotsDialog.spec.ts`
- Test: `apps/admin-web/src/features/teaching/SessionRosterDrawer.spec.ts`
- Modify: `apps/admin-web/src/router/index.ts`
- Modify: `apps/admin-web/src/layouts/AdminLayout.vue`

**Interfaces:**
- Consumes: all M2 admin endpoints.
- Produces: resource, scheduling, roster, attendance, correction, and manual-settlement workflows.

- [ ] **Step 1: Write failing operator tests**

~~~ts
it('shows a conflict without losing the draft batch', async () => {
  api.publishSessions.mockRejectedValueOnce(businessError('TEACHER_TIME_CONFLICT'));
  await wrapper.get('[data-testid="publish"]').trigger('click');
  expect(wrapper.text()).toContain('老师时间冲突');
  expect(wrapper.get('[name="weekdays"]').element.value).not.toBe('');
});

it('requires reason and expected version for attendance correction', async () => {
  await correctionDialog.setTarget('NO_SHOW');
  await correctionDialog.submit();
  expect(api.correctAttendance).not.toHaveBeenCalled();
});
~~~

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @member-course/admin-web test -- src/features/teaching`

Expected: teaching views missing.

- [ ] **Step 3: Implement the workspace**

Provide course-policy version editing, dense calendar/list switching, batch and one-to-one dialogs, publish/reschedule/cancel commands, roster drawer, bulk check-in/no-show, correction history, and manual settlement. Send one stable idempotency key per user command and the displayed version.

- [ ] **Step 4: Run component tests**

Run: `pnpm --filter @member-course/admin-web test -- src/features/teaching`

Expected: CRUD, batch, conflict, session lifecycle, roster, settlement, and correction tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/admin-web/src/api apps/admin-web/src/features/teaching apps/admin-web/src/router apps/admin-web/src/layouts
git commit -m "feat(admin): add scheduling and attendance workspace"
~~~

### Task 10: Build Mini-Program Timetable and Booking Journeys

**Files:**
- Create: `apps/miniapp/miniprogram/services/scheduling.ts`
- Create: `apps/miniapp/miniprogram/services/bookings.ts`
- Create: `apps/miniapp/miniprogram/pages/schedule/index.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/session/detail.{ts,json,wxml,wxss}`
- Create: `apps/miniapp/miniprogram/pages/bookings/index.{ts,json,wxml,wxss}`
- Test: `apps/miniapp/tests/services/scheduling.spec.ts`
- Test: `apps/miniapp/tests/services/bookings.spec.ts`
- Test: `apps/miniapp/tests/pages/schedule.spec.ts`
- Test: `apps/miniapp/tests/pages/session-detail.spec.ts`
- Test: `apps/miniapp/tests/pages/bookings.spec.ts`
- Test: `apps/miniapp/tests/custom-tab-bar.spec.ts`
- Modify: `apps/miniapp/miniprogram/app.json`
- Create: `apps/miniapp/miniprogram/custom-tab-bar/index.{ts,json,wxml,wxss}`

**Interfaces:**
- Consumes: M2 mini APIs and M1 current-student store.
- Produces: `课表` tab, session detail, book/cancel, and attempt history.

- [ ] **Step 1: Write failing user-flow tests**

~~~ts
it('shows an actionable full-session response', async () => {
  api.book.mockRejectedValueOnce(businessError('SESSION_FULL'));
  await page.book();
  expect(page.data.errorAction).toEqual({ label: '选择其他时段', route: '/pages/schedule/index' });
});

it('does not submit when the account is unbound', async () => {
  sessionStore.setSession({ bound: false });
  await page.book();
  expect(api.book).not.toHaveBeenCalled();
  expect(page.data.errorCode).toBe('PHONE_BINDING_REQUIRED');
});
~~~

- [ ] **Step 2: Verify failure**

Run:

~~~bash
pnpm --filter @member-course/miniapp test -- tests/services/scheduling.spec.ts tests/services/bookings.spec.ts tests/pages/schedule.spec.ts tests/pages/session-detail.spec.ts tests/pages/bookings.spec.ts tests/custom-tab-bar.spec.ts
~~~

Expected: pages and services missing.

- [ ] **Step 3: Implement exact UI behavior**

Show selected student, class/one-to-one type, teacher, room, start/end, required hours, remaining seats, booking window, cancellation rule, current attempt, and history. Map `SESSION_FULL`, `TIME_CONFLICT`, `HOURS_INSUFFICIENT`, `PACKAGE_NOT_VALID_FOR_SESSION`, and `STATE_CHANGED` to concrete actions.

- [ ] **Step 4: Run tests**

Run:

~~~bash
pnpm --filter @member-course/miniapp test -- tests/services/scheduling.spec.ts tests/services/bookings.spec.ts tests/pages/schedule.spec.ts tests/pages/session-detail.spec.ts tests/pages/bookings.spec.ts tests/custom-tab-bar.spec.ts
~~~

Expected: bound gating, student switch, book, on-time/late cancel result, history, stale state, and cache isolation tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/miniapp
git commit -m "feat(miniapp): add timetable and booking flow"
~~~

### Task 11: Verify the Complete M2 Teaching Journey

**Files:**
- Create: `apps/api/test/e2e/m2-teaching-journey.e2e-spec.ts`
- Create: `apps/api/test/integration/m2-concurrency.integration-spec.ts`
- Create: `apps/admin-web/e2e/m2-scheduling-flow.spec.ts`
- Create: `apps/miniapp/tests/m2-booking-journey.spec.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: all M1 and M2 tasks.
- Produces: M2 acceptance and regression gate.

- [ ] **Step 1: Write the failing closed-loop journey**

~~~ts
it('schedules, books, checks in, and preserves a traceable balance', async () => {
  const session = await admin.publishClassSession({ deductAt: 'ATTENDANCE', requiredHours: '1.00' });
  const booking = await mini.book(studentId, session.id);
  expect(await packageBuckets(packageId)).toMatchObject({ available: '9.00', reserved: '1.00' });
  await admin.checkIn(booking.id);
  expect(await packageBuckets(packageId)).toMatchObject({ reserved: '0.00', consumed: '1.00' });
  await admin.correctAttendance(booking.id, 'NO_SHOW', '录入错误');
  expect(await attendanceHistory(booking.id)).toHaveLength(2);
  expect(await ledgerBalancesEqualPostings(studentId, courseId)).toBe(true);
});
~~~

- [ ] **Step 2: Add concurrency and boundary assertions**

Assert one winner for last seat, one winner for overlapping student bookings, one winner for overlapping teacher/room publication, exact cancellation deadline, expired reversal bucket, new rebooking attempt, and 29:59/30:00 settlement.

- [ ] **Step 3: Run M2 tests**

~~~bash
pnpm --filter @member-course/api test
pnpm --filter @member-course/api test:integration
pnpm --filter @member-course/api test:e2e
pnpm --filter @member-course/admin-web test
pnpm --filter @member-course/admin-web test:e2e
pnpm --filter @member-course/miniapp test
~~~

Expected: all M1 regression and M2 target suites pass.

- [ ] **Step 4: Run the repository gate**

~~~bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @member-course/api prisma validate
git diff --check
~~~

Expected: every command exits 0.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/test apps/admin-web/e2e apps/miniapp/tests .github/workflows/ci.yml README.md
git commit -m "test: verify m2 teaching and attendance journey"
~~~

## M2 Completion Gate

M2 is complete only when:

1. Class and one-to-one sessions publish with immutable rule snapshots.
2. Resource and student conflicts remain correct under concurrent MySQL transactions.
3. Booking-time and attendance-time deduction modes both reconcile to the append-only ledger.
4. Cancellation, no-show, institution cancellation, and attendance correction return or consume the original allocations correctly.
5. Closed bookings remain immutable and rebooking creates a new attempt.
6. Manual and automatic settlement share one idempotent command and the 30-minute boundary is proven.
7. Admin and mini-program journeys pass with all M1 regressions.
