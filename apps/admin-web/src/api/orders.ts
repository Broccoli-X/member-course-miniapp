/**
 * Admin offline-order API client (Task 9).
 *
 * Wraps the Task 9 endpoints:
 *   - GET    /api/admin/v1/orders               (paged, filter status/buyer)
 *   - POST   /api/admin/v1/orders               (create PENDING draft)
 *   - GET    /api/admin/v1/orders/:id           (detail)
 *   - POST   /api/admin/v1/orders/:id/confirm   (idempotent)
 *   - POST   /api/admin/v1/orders/:id/void      (idempotent)
 *   - POST   /api/admin/v1/orders/:id/reverse   (idempotent; needs reason)
 *
 * Money (totalAmount, unitPriceSnapshot) and lesson hours (hoursSnapshot) are
 * 2-dp decimal strings on the wire and are passed through unchanged (never
 * coerced to a JS number — global constraint).
 *
 * confirm/void/reverse are idempotent: the server dedupes by the
 * `Idempotency-Key` header, so a caller who retries a confirm (e.g. the admin
 * double-clicks) executes the work exactly once. Callers pass a stable key
 * they generated once per logical action.
 */
import { http } from './http';
import type { PaginatedResult } from '@member-course/contracts';
import type {
  OfflineOrderDto,
  CreateOfflineOrderCommand,
  VoidDraftResult,
} from '@member-course/contracts';

export interface ListOrdersParams {
  page?: number;
  pageSize?: number;
  status?: string;
  buyerAccountId?: string;
}

export const ordersApi = {
  listOrders(params: ListOrdersParams = {}): Promise<PaginatedResult<OfflineOrderDto>> {
    return http.get<PaginatedResult<OfflineOrderDto>>('/admin/v1/orders', {
      query: {
        page: params.page,
        pageSize: params.pageSize,
        status: params.status,
        buyerAccountId: params.buyerAccountId,
      },
    });
  },
  createOrder(body: CreateOfflineOrderCommand): Promise<OfflineOrderDto> {
    return http.post<OfflineOrderDto>('/admin/v1/orders', body);
  },
  getOrder(id: string): Promise<OfflineOrderDto> {
    return http.get<OfflineOrderDto>(`/admin/v1/orders/${id}`);
  },
  /**
   * Confirm a PENDING order (creates one CoursePackage per item + posts a GRANT
   * into the hour ledger). Idempotent: pass the SAME `idempotencyKey` for a
   * single logical confirm so a double-click / retry only runs once.
   */
  confirmOrder(id: string, idempotencyKey: string): Promise<OfflineOrderDto> {
    return http.post<OfflineOrderDto>(`/admin/v1/orders/${id}/confirm`, undefined, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },
  /**
   * Void a still-PENDING draft (physically removes it; no packages were
   * granted). Idempotent: pass a stable key for replay safety.
   */
  voidOrder(id: string, idempotencyKey: string): Promise<VoidDraftResult> {
    return http.post<VoidDraftResult>(`/admin/v1/orders/${id}/void`, undefined, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },
  /**
   * Reverse a CONFIRMED order (appends a REVERSAL into the ledger; never
   * mutates the original GRANT). Idempotent: pass a stable key. A used order
   * (one whose packages already have downstream consumption/adjustments) is
   * rejected by the server with `ORDER_NOT_REVERSIBLE` (409).
   */
  reverseOrder(
    id: string,
    body: { reason?: string },
    idempotencyKey: string,
  ): Promise<OfflineOrderDto> {
    return http.post<OfflineOrderDto>(`/admin/v1/orders/${id}/reverse`, body, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },
};

export default ordersApi;
