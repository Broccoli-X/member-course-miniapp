/**
 * Admin lesson-hour API client (Tasks 10 + 11).
 *
 * Wraps:
 *   - POST /api/admin/v1/students/:studentId/courses/:courseId/hour-adjustments/grant
 *        (manual grant — units/startsOn/expiresOn/reason; nonblank reason)
 *   - POST /api/admin/v1/students/:studentId/courses/:courseId/hour-adjustments/debit
 *        (manual debit — units/reason; nonblank reason)
 *   - GET  /api/admin/v1/students/:studentId/course-balances   (paged)
 *   - GET  /api/admin/v1/students/:studentId/course-packages   (paged)
 *   - GET  /api/admin/v1/students/:studentId/hour-transactions (paged)
 *
 * Every decimal (units, balance deltas, granted/available/...) is a 2-dp string
 * on the wire and is passed through unchanged (never coerced to a JS number).
 * The admin surface can read ANY student's assets (no relation gate).
 */
import { http } from './http';
import type { PaginatedResult } from '@member-course/contracts';
import type {
  HourPostingResult,
  ManualGrantCommand,
  ManualDebitCommand,
  CourseBalanceView,
  CoursePackageView,
  HourTransactionView,
} from '@member-course/contracts';

export interface ListPageParams {
  page?: number;
  pageSize?: number;
  sort?: string;
}

export const hoursApi = {
  /**
   * Manual grant: creates a separate CoursePackage (sourceType: MANUAL) and
   * posts a MANUAL_GRANT HourTransaction. `units`/`startsOn`/`expiresOn`/`reason`
   * are passed through as strings; a nonblank reason is required (the server
   * enforces it; the UI mirrors the rule for early feedback).
   */
  grantHours(
    studentId: string,
    courseId: string,
    body: Omit<ManualGrantCommand, 'studentId' | 'courseId'>,
  ): Promise<HourPostingResult> {
    return http.post<HourPostingResult>(
      `/admin/v1/students/${studentId}/courses/${courseId}/hour-adjustments/grant`,
      body,
    );
  },
  /**
   * Manual debit: draws `units` from `available` across eligible packages via
   * FEFO and posts a MANUAL_DEDUCT HourTransaction. Rejects with
   * INSUFFICIENT_HOURS if it would overdraw. Nonblank reason required.
   */
  debitHours(
    studentId: string,
    courseId: string,
    body: Omit<ManualDebitCommand, 'studentId' | 'courseId'>,
  ): Promise<HourPostingResult> {
    return http.post<HourPostingResult>(
      `/admin/v1/students/${studentId}/courses/${courseId}/hour-adjustments/debit`,
      body,
    );
  },
  /** Read-only: a student's per-course balance rows. */
  listBalances(
    studentId: string,
    params: ListPageParams = {},
  ): Promise<PaginatedResult<CourseBalanceView>> {
    return http.get<PaginatedResult<CourseBalanceView>>(
      `/admin/v1/students/${studentId}/course-balances`,
      { query: { page: params.page, pageSize: params.pageSize } },
    );
  },
  /** Read-only: a student's CoursePackage rows. */
  listPackages(
    studentId: string,
    params: ListPageParams = {},
  ): Promise<PaginatedResult<CoursePackageView>> {
    return http.get<PaginatedResult<CoursePackageView>>(
      `/admin/v1/students/${studentId}/course-packages`,
      { query: { page: params.page, pageSize: params.pageSize } },
    );
  },
  /** Read-only: a student's append-only HourTransaction rows. */
  listTransactions(
    studentId: string,
    params: ListPageParams = {},
  ): Promise<PaginatedResult<HourTransactionView>> {
    return http.get<PaginatedResult<HourTransactionView>>(
      `/admin/v1/students/${studentId}/hour-transactions`,
      { query: { page: params.page, pageSize: params.pageSize, sort: params.sort } },
    );
  },
};

export default hoursApi;
