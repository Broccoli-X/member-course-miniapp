/**
 * Member asset query service (Task 15).
 *
 * Thin typed wrappers over the Task-11 READ endpoints. All numeric values
 * come back as canonical 2-dp decimal strings (e.g. `"2.00"`); they are kept
 * as strings on the client so no JS floating-point math is performed on
 * money/lesson-hour fields. Every call is authenticated (`request`, not
 * `publicRequest`) — the server enforces `MiniAuthGuard` + `BoundMemberGuard`
 * and, for the per-student routes, `StudentAccessService.assertRelated`
 * (returns 403 `STUDENT_FORBIDDEN` when the member is not related to the
 * student).
 *
 * Pagination follows the shared `{items,total,page,pageSize,totalPages}`
 * envelope; `page`/`pageSize` are 1-based.
 */

import { request } from './http';

// ── View types (mirror @member-course/contracts; copied here so the miniapp
//    doesn't need a runtime dep on the contracts package — its types are
//    stripped at build time and the WeChat runtime only loads .ts compiled
//    in place). All decimal fields are 2-dp strings. ──────────────────────

export interface MiniOrderItemView {
  id: string;
  orderId: string;
  studentId: string;
  productId: string;
  courseId: string;
  /** Frozen product name at order time. */
  productNameSnapshot: string;
  /** Frozen unit price (2-dp decimal string). */
  unitPriceSnapshot: string;
  /** Frozen granted hours (2-dp decimal string). */
  hoursSnapshot: string;
  validDaysSnapshot: number;
  coursePackageId: string | null;
  grantTransactionId: string | null;
}

export interface MiniOrderView {
  id: string;
  buyerAccountId: string;
  status: string;
  /** Σ item.unitPriceSnapshot (2-dp decimal string). */
  totalAmount: string;
  /** ISO 8601 timestamp of confirmation, or null. */
  confirmedAt: string | null;
  items: MiniOrderItemView[];
}

export interface CourseBalanceView {
  id: string;
  studentId: string;
  courseId: string;
  available: string;
  reserved: string;
  consumed: string;
  expired: string;
}

export interface CoursePackageView {
  id: string;
  studentId: string;
  courseId: string;
  sourceType: string;
  status: string;
  /** `YYYY-MM-DD` — the package effective date (`startsOn`). */
  startsOn: string;
  /** `YYYY-MM-DD` — the package expiry date (`expiresOn`). */
  expiresOn: string;
  granted: string;
  available: string;
  reserved: string;
  consumed: string;
  expired: string;
}

export interface HourAllocationView {
  id: string;
  transactionId: string;
  packageId: string;
  sourceType: string;
  sourceId: string;
  availableDelta: string;
  reservedDelta: string;
  consumedDelta: string;
  expiredDelta: string;
}

export interface HourTransactionView {
  id: string;
  studentId: string;
  courseId: string;
  type: string;
  businessKey: string;
  originalTransactionId: string | null;
  availableDelta: string;
  reservedDelta: string;
  consumedDelta: string;
  expiredDelta: string;
  /** Manual-debit reason (audited on the row); null on non-manual rows. */
  reason: string | null;
  /** ISO 8601 timestamp of when the transaction took effect. */
  occurredAt: string;
  allocations: HourAllocationView[];
}

export interface PaginatedView<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PageParams {
  page?: number;
  pageSize?: number;
}

function withQuery(path: string, params?: PageParams): string {
  if (!params) return path;
  const parts: string[] = [];
  if (params.page !== undefined) parts.push(`page=${params.page}`);
  if (params.pageSize !== undefined) parts.push(`pageSize=${params.pageSize}`);
  return parts.length > 0 ? `${path}?${parts.join('&')}` : path;
}

// ── Member's own orders (buyer isolation enforced server-side). ──────────

/** `GET /api/mini/v1/orders` — paginated list of the member's own orders. */
export function listOrders(
  params?: PageParams,
): Promise<PaginatedView<MiniOrderView>> {
  return request<PaginatedView<MiniOrderView>>({
    path: withQuery('/api/mini/v1/orders', params),
  });
}

/** `GET /api/mini/v1/orders/:id` — detail of one of the member's own orders. */
export function getOrder(orderId: string): Promise<MiniOrderView> {
  return request<MiniOrderView>({
    path: `/api/mini/v1/orders/${orderId}`,
  });
}

// ── Per-student assets (assertRelated enforced server-side). ─────────────

/** `GET /api/mini/v1/students/:studentId/course-balances`. */
export function listBalances(
  studentId: string,
  params?: PageParams,
): Promise<PaginatedView<CourseBalanceView>> {
  return request<PaginatedView<CourseBalanceView>>({
    path: withQuery(
      `/api/mini/v1/students/${studentId}/course-balances`,
      params,
    ),
  });
}

/** `GET /api/mini/v1/students/:studentId/course-packages`. */
export function listPackages(
  studentId: string,
  params?: PageParams,
): Promise<PaginatedView<CoursePackageView>> {
  return request<PaginatedView<CoursePackageView>>({
    path: withQuery(
      `/api/mini/v1/students/${studentId}/course-packages`,
      params,
    ),
  });
}

/** `GET /api/mini/v1/students/:studentId/hour-transactions` (newest first). */
export function listHourTransactions(
  studentId: string,
  params?: PageParams,
): Promise<PaginatedView<HourTransactionView>> {
  return request<PaginatedView<HourTransactionView>>({
    path: withQuery(
      `/api/mini/v1/students/${studentId}/hour-transactions`,
      params,
    ),
  });
}
