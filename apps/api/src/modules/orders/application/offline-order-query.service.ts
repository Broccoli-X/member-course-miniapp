import { Injectable } from '@nestjs/common';
import {
  type MiniOrderItemView,
  type MiniOrderView,
  type OfflineOrderDto,
  type OfflineOrderItemDto,
  type OfflineOrderStatus,
  type PaginatedResult,
  type PaginationParams,
} from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import { toDecimalString } from '../../catalog/application/decimal-validation.js';
import type { Prisma } from '../../../generated/prisma/client.js';

/**
 * Read-side queries for offline orders.
 *
 * Returns the wire {@link OfflineOrderDto} with frozen item snapshots and the
 * package / grant-transaction links (filled in at confirm time). Decimal fields
 * are rendered as 2-dp strings.
 */
@Injectable()
export class OfflineOrderQueryService {
  constructor(private readonly db: PrismaService) {}

  /**
   * Paginated admin order list. Optionally filtered by `status`
   * (PENDING|CONFIRMED|REVERSED) and/or `buyerAccountId`. Ordered newest-first.
   */
  async list(
    params: PaginationParams & { status?: string; buyerAccountId?: string },
  ): Promise<PaginatedResult<OfflineOrderDto>> {
    const where: { status?: string; buyerAccountId?: string } = {};
    if (params.status) where.status = params.status;
    if (params.buyerAccountId) where.buyerAccountId = params.buyerAccountId;

    const [total, rows] = await Promise.all([
      this.db.offlineOrder.count({ where }),
      this.db.offlineOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { items: { include: ITEM_INCLUDE, orderBy: { createdAt: 'asc' } } },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    return {
      items: rows.map((o) => toOrderDto(o)),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages,
    };
  }

  /**
   * Fetch a single order by id with its items. Throws `RESOURCE_NOT_FOUND`
   * (404) when missing.
   */
  async detail(orderId: string): Promise<OfflineOrderDto> {
    const row = await this.db.offlineOrder.findUnique({
      where: { id: orderId },
      include: { items: { include: ITEM_INCLUDE, orderBy: { createdAt: 'asc' } } },
    });
    if (!row) {
      throw BusinessError.notFound('Order not found', { orderId });
    }
    return toOrderDto(row);
  }

  // ── Mini-program (member) buyer-scoped reads (Task 11) ─────────────────

  /**
   * Paginated order list scoped to a single buyer (`buyerAccountId`). This is
   * the backing query for `GET /api/mini/v1/orders` — the member sees ONLY
   * their own orders (buyer isolation). Ordered newest-first.
   */
  async listForBuyer(
    buyerAccountId: string,
    params: PaginationParams,
  ): Promise<PaginatedResult<MiniOrderView>> {
    const where = { buyerAccountId };
    const [total, rows] = await Promise.all([
      this.db.offlineOrder.count({ where }),
      this.db.offlineOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { items: { include: ITEM_INCLUDE, orderBy: { createdAt: 'asc' } } },
      }),
    ]);
    return {
      items: rows.map(toMiniOrderView),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    };
  }

  /**
   * Detail of one order for the mini surface, scoped to `buyerAccountId`. A
   * row that belongs to a DIFFERENT buyer is treated identically to a missing
   * row (404 RESOURCE_NOT_FOUND) — this deliberately does NOT leak existence of
   * another member's order id (the brief leaves 403-vs-404 open; 404 for both
   * is chosen to avoid an enumeration side-channel). See task-11-report.md.
   */
  async detailForBuyer(orderId: string, buyerAccountId: string): Promise<MiniOrderView> {
    const row = await this.db.offlineOrder.findUnique({
      where: { id: orderId },
      include: { items: { include: ITEM_INCLUDE, orderBy: { createdAt: 'asc' } } },
    });
    if (!row || row.buyerAccountId !== buyerAccountId) {
      throw BusinessError.notFound('Order not found', { orderId });
    }
    return toMiniOrderView(row);
  }
}

/**
 * The CoursePackage relation (with its allocations) to eager-load on each order
 * item so the DTO can resolve `coursePackageId` + `grantTransactionId`. The
 * allocations are the GRANT slice (and any later posting); the DTO surfaces the
 * first allocation's transaction id as the grant id.
 */
const ITEM_INCLUDE = {
  coursePackage: {
    select: {
      id: true,
      allocations: {
        select: { transactionId: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  },
} as const;

// ── Row → DTO mappers ─────────────────────────────────────────────────────

/**
 * The minimal order shape `toOrderDto` needs (an OfflineOrder row plus its
 * items). Declared structurally so both the raw Prisma include-result and a
 * hand-built test fixture satisfy it.
 */
type OrderRowWithItems = Prisma.OfflineOrderGetPayload<{
  include: { items: true };
}>;

/** Convert a Prisma OfflineOrder (+ items) row to the wire {@link OfflineOrderDto}. */
export function toOrderDto(row: OrderRowWithItems): OfflineOrderDto {
  return {
    id: row.id,
    buyerAccountId: row.buyerAccountId,
    status: row.status as OfflineOrderStatus | string,
    totalAmount: toDecimalString(row.totalAmount) ?? '0.00',
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    items: row.items.map(toItemDto),
    version: row.version,
  };
}

/**
 * Convert a Prisma OrderItem row to the wire {@link OfflineOrderItemDto}. The
 * `coursePackageId` / `grantTransactionId` are derived from the item's optional
 * `coursePackage` relation (set at confirm time).
 */
export function toItemDto(
  item: Prisma.OrderItemGetPayload<{
    include?: { coursePackage?: true };
  }> & { coursePackage?: { id: string; allocations?: { transactionId: string }[] } | null },
): OfflineOrderItemDto {
  // The GRANT transaction id is the single HourAllocation recorded against this
  // package at confirm time (a later posting would add more; that's a reversal
  // guard, not a display concern here). Resolve via the relation when present.
  let coursePackageId: string | null = null;
  let grantTransactionId: string | null = null;
  if (item.coursePackage) {
    coursePackageId = item.coursePackage.id;
    grantTransactionId = item.coursePackage.allocations?.[0]?.transactionId ?? null;
  }
  return {
    id: item.id,
    orderId: item.orderId,
    studentId: item.studentId,
    productId: item.productId,
    courseId: item.courseId,
    productNameSnapshot: item.productNameSnapshot,
    unitPriceSnapshot: toDecimalString(item.unitPriceSnapshot) ?? '0.00',
    hoursSnapshot: toDecimalString(item.hoursSnapshot) ?? '0.00',
    validDaysSnapshot: item.validDaysSnapshot,
    coursePackageId,
    grantTransactionId,
    version: item.version,
  };
}

// ── Mini-program (member) view mappers (Task 11) ──────────────────────────

/**
 * Convert an order item (with its optional `coursePackage` relation) to the
 * mini {@link MiniOrderItemView}. Same fields as the admin item view minus the
 * internal `version` (the mini client never needs optimistic-lock info).
 */
export function toMiniItemView(
  item: Prisma.OrderItemGetPayload<{
    include?: { coursePackage?: true };
  }> & { coursePackage?: { id: string; allocations?: { transactionId: string }[] } | null },
): MiniOrderItemView {
  let coursePackageId: string | null = null;
  let grantTransactionId: string | null = null;
  if (item.coursePackage) {
    coursePackageId = item.coursePackage.id;
    grantTransactionId = item.coursePackage.allocations?.[0]?.transactionId ?? null;
  }
  return {
    id: item.id,
    orderId: item.orderId,
    studentId: item.studentId,
    productId: item.productId,
    courseId: item.courseId,
    productNameSnapshot: item.productNameSnapshot,
    unitPriceSnapshot: toDecimalString(item.unitPriceSnapshot) ?? '0.00',
    hoursSnapshot: toDecimalString(item.hoursSnapshot) ?? '0.00',
    validDaysSnapshot: item.validDaysSnapshot,
    coursePackageId,
    grantTransactionId,
  };
}

/**
 * Convert an OfflineOrder (+ items) row to the mini {@link MiniOrderView}. The
 * member sees their own orders only; `buyerAccountId` is included so the client
 * can echo it. Decimal fields are 2-dp strings; `confirmedAt` is ISO 8601.
 */
export function toMiniOrderView(row: OrderRowWithItems): MiniOrderView {
  return {
    id: row.id,
    buyerAccountId: row.buyerAccountId,
    status: row.status as OfflineOrderStatus | string,
    totalAmount: toDecimalString(row.totalAmount) ?? '0.00',
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    items: row.items.map(toMiniItemView),
  };
}
