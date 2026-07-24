import { Injectable } from '@nestjs/common';
import {
  type CourseBalanceView,
  type CoursePackageView,
  type HourAllocationView,
  type HourTransactionView,
  type PaginatedResult,
  type PaginationParams,
} from '@member-course/contracts';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { toDecimalString } from '../../catalog/application/decimal-validation.js';

/** The persisted decimal column type (Prisma maps `Decimal(10,2)` to this). */
type DecimalField = Prisma.Decimal | string;

/**
 * Read-only lesson-hour asset queries shared by the mini and admin surfaces
 * (Task 11).
 *
 * Three shapes, all isolated by `studentId`:
 *  - {@link listBalances} — `StudentCourseBalance` rows (the live per-course
 *    summary, one row per (student, course)).
 *  - {@link listPackages} — `CoursePackage` rows (the per-package breakdown
 *    with granted/available/reserved/consumed/expired).
 *  - {@link listTransactions} — `HourTransaction` rows WITH their nested
 *    `HourAllocation` rows; ordered newest-first (by `occurredAt` desc).
 *
 * Authorization is NOT performed here — the mini controller MUST call
 * `StudentAccessService.assertRelated(accountId, studentId)` BEFORE invoking
 * these queries; the admin controller calls them directly (admin can view any
 * student). Keeping the auth gate in the controller mirrors the rest of the
 * mini surface and keeps this service reusable for both callers.
 *
 * Every Decimal field is rendered as a canonical 2-dp string via
 * {@link toDecimalString}; `@db.Date` columns (startsOn/expiresOn) are rendered
 * as `YYYY-MM-DD` (matching `StudentProfile.birthDate`); `occurredAt` (a
 * `DateTime`) is rendered as an ISO 8601 string.
 */
@Injectable()
export class MemberAssetQueryService {
  constructor(private readonly db: PrismaService) {}

  /** Paginated `StudentCourseBalance` rows for a student, ordered by course. */
  async listBalances(
    studentId: string,
    params: PaginationParams,
  ): Promise<PaginatedResult<CourseBalanceView>> {
    const where = { studentId };
    const [total, rows] = await Promise.all([
      this.db.studentCourseBalance.count({ where }),
      this.db.studentCourseBalance.findMany({
        where,
        orderBy: { courseId: 'asc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);
    return {
      items: rows.map(toBalanceView),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    };
  }

  /** Paginated `CoursePackage` rows for a student, newest grant first. */
  async listPackages(
    studentId: string,
    params: PaginationParams,
  ): Promise<PaginatedResult<CoursePackageView>> {
    const where = { studentId };
    const [total, rows] = await Promise.all([
      this.db.coursePackage.count({ where }),
      this.db.coursePackage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);
    return {
      items: rows.map(toPackageView),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    };
  }

  /**
   * Paginated `HourTransaction` rows (WITH nested `HourAllocation`) for a
   * student, newest-effect first (occurredAt desc). A `sort=oldest` param flips
   * the order to occurredAt asc for callers that want chronological history.
   */
  async listTransactions(
    studentId: string,
    params: PaginationParams,
  ): Promise<PaginatedResult<HourTransactionView>> {
    const where = { studentId };
    const direction = params.sort === 'oldest' ? 'asc' : 'desc';
    const [total, rows] = await Promise.all([
      this.db.hourTransaction.count({ where }),
      this.db.hourTransaction.findMany({
        where,
        orderBy: { occurredAt: direction },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          allocations: {
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
    ]);
    return {
      items: rows.map(toTransactionView),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    };
  }
}

// ── Row → DTO mappers ─────────────────────────────────────────────────────

/** Render a `@db.Date` column as `YYYY-MM-DD` (UTC). Mirrors birthDate. */
function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Convert a `StudentCourseBalance` row to {@link CourseBalanceView}. */
export function toBalanceView(row: {
  id: string;
  studentId: string;
  courseId: string;
  available: DecimalField;
  reserved: DecimalField;
  consumed: DecimalField;
  expired: DecimalField;
}): CourseBalanceView {
  return {
    id: row.id,
    studentId: row.studentId,
    courseId: row.courseId,
    available: toDecimalString(row.available) ?? '0.00',
    reserved: toDecimalString(row.reserved) ?? '0.00',
    consumed: toDecimalString(row.consumed) ?? '0.00',
    expired: toDecimalString(row.expired) ?? '0.00',
  };
}

/** Convert a `CoursePackage` row to {@link CoursePackageView}. */
export function toPackageView(row: {
  id: string;
  studentId: string;
  courseId: string;
  sourceType: string;
  status: string;
  startsOn: Date;
  expiresOn: Date;
  granted: DecimalField;
  available: DecimalField;
  reserved: DecimalField;
  consumed: DecimalField;
  expired: DecimalField;
}): CoursePackageView {
  return {
    id: row.id,
    studentId: row.studentId,
    courseId: row.courseId,
    sourceType: row.sourceType,
    status: row.status,
    startsOn: toDateOnly(row.startsOn),
    expiresOn: toDateOnly(row.expiresOn),
    granted: toDecimalString(row.granted) ?? '0.00',
    available: toDecimalString(row.available) ?? '0.00',
    reserved: toDecimalString(row.reserved) ?? '0.00',
    consumed: toDecimalString(row.consumed) ?? '0.00',
    expired: toDecimalString(row.expired) ?? '0.00',
  };
}

/** Convert an `HourAllocation` row to {@link HourAllocationView}. */
export function toAllocationView(row: {
  id: string;
  transactionId: string;
  packageId: string;
  sourceType: string;
  sourceId: string;
  availableDelta: DecimalField;
  reservedDelta: DecimalField;
  consumedDelta: DecimalField;
  expiredDelta: DecimalField;
}): HourAllocationView {
  return {
    id: row.id,
    transactionId: row.transactionId,
    packageId: row.packageId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    availableDelta: toDecimalString(row.availableDelta) ?? '0.00',
    reservedDelta: toDecimalString(row.reservedDelta) ?? '0.00',
    consumedDelta: toDecimalString(row.consumedDelta) ?? '0.00',
    expiredDelta: toDecimalString(row.expiredDelta) ?? '0.00',
  };
}

/** Convert an `HourTransaction` (with allocations) row to {@link HourTransactionView}. */
export function toTransactionView(row: {
  id: string;
  studentId: string;
  courseId: string;
  type: string;
  businessKey: string;
  originalTransactionId: string | null;
  availableDelta: DecimalField;
  reservedDelta: DecimalField;
  consumedDelta: DecimalField;
  expiredDelta: DecimalField;
  reason: string | null;
  occurredAt: Date;
  allocations?: ReadonlyArray<Parameters<typeof toAllocationView>[0]>;
}): HourTransactionView {
  return {
    id: row.id,
    studentId: row.studentId,
    courseId: row.courseId,
    type: row.type,
    businessKey: row.businessKey,
    originalTransactionId: row.originalTransactionId,
    availableDelta: toDecimalString(row.availableDelta) ?? '0.00',
    reservedDelta: toDecimalString(row.reservedDelta) ?? '0.00',
    consumedDelta: toDecimalString(row.consumedDelta) ?? '0.00',
    expiredDelta: toDecimalString(row.expiredDelta) ?? '0.00',
    reason: row.reason,
    occurredAt: row.occurredAt.toISOString(),
    allocations: (row.allocations ?? []).map(toAllocationView),
  };
}
