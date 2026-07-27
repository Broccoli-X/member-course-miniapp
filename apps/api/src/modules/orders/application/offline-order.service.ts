import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  CATALOG_STATUS,
  ERROR_CODES,
  HTTP_STATUS,
  OFFLINE_ORDER_STATUS,
  type CommandContext,
  type CreateOfflineOrderCommand,
  type OfflineOrderDto,
  type ReverseOfflineOrderCommand,
  type VoidDraftResult,
} from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import {
  IdempotencyService,
  type IdempotentRequest,
} from '../../../common/idempotency/idempotency.service.js';
import { HourLedgerService } from '../../hours/application/hour-ledger.service.js';
import { calculateExpiryDate, toShanghaiDateString } from '../../../common/time/business-date.js';
import {
  assertCanConfirm,
  assertCanReverse,
  assertCanVoid,
  freezeItemSnapshot,
} from '../domain/offline-order-state.js';
import { toOrderDto } from './offline-order-query.service.js';

/**
 * `OfflineOrderService` — the offline-order lifecycle (Task 9).
 *
 * Admins record offline orders as PENDING drafts that freeze a product
 * snapshot (name/price/hours/validDays) at draft time, then CONFIRM them in a
 * single transaction that creates one CoursePackage per item AND posts a GRANT
 * into the lesson-hour ledger on the SAME transaction. A CONFIRMED order may be
 * REVERSED (which appends a REVERSAL posting) provided none of its packages
 * have any downstream activity; a PENDING draft may be VOIDED (removed).
 *
 * ## Confirm — the critical transaction
 *
 * `confirm` is wired through {@link IdempotencyService.execute}, which runs the
 * work inside ONE `PrismaService.$transaction(tx => ...)`. Inside that `tx` we,
 * for each item: create the CoursePackage (sourceType ORDER, expiry via
 * inclusive `validDays - 1`), then call
 * {@link HourLedgerService.grantOrder} on the SAME `tx` passing the just-created
 * package's id. Because grant and package-create share the caller's tx, a
 * failure partway rolls back BOTH the ledger posting AND the packages AND the
 * order status flip — money + hours stay reconciled.
 *
 * Idempotency: two concurrent confirms with the same idempotency key share the
 * IdempotencyService's in-flight Promise (and the persisted record), so the
 * work runs exactly once → exactly one package and one grant per item.
 *
 * ## Reverse — strict (ORDER_NOT_REVERSIBLE)
 *
 * A CONFIRMED order can be reversed only if NONE of its packages have any
 * posting after the original GRANT (a consumption/adjustment). Before reversing
 * we count each package's HourAllocations: the GRANT made exactly one; anything
 * more means downstream activity exists and we throw `ORDER_NOT_REVERSIBLE`
 * (HTTP 409) without mutating anything.
 *
 * ## Void
 *
 * The schema has no VOIDED status. A PENDING draft has no packages/grants, so
 * voiding physically removes the draft and its items (no ledger side effects).
 * Voiding a CONFIRMED/REVERSED order is rejected (state machine).
 */
@Injectable()
export class OfflineOrderService {
  constructor(
    private readonly db: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly ledger: HourLedgerService,
  ) {}

  // ── createDraft ────────────────────────────────────────────────────────

  /**
   * Create a PENDING order draft. Freezes each item's product snapshot from the
   * ACTIVE PackageProduct at draft time (so later product edits do not move an
   * in-flight order). Computes `totalAmount` = Σ unitPriceSnapshot via
   * Prisma.Decimal (never JS number). Validates the buyer account, each student,
   * and each product (ACTIVE) exists.
   */
  async createDraft(
    command: CreateOfflineOrderCommand,
    adminId: string,
  ): Promise<OfflineOrderDto> {
    if (!Array.isArray(command.items) || command.items.length === 0) {
      throw BusinessError.validationFailed('Order must contain at least one item', {
        field: 'items',
      });
    }

    // Validate the buyer account exists.
    const buyer = await this.db.memberAccount.findUnique({
      where: { id: command.buyerAccountId },
    });
    if (!buyer) {
      throw BusinessError.notFound('Buyer account not found', {
        buyerAccountId: command.buyerAccountId,
      });
    }

    // Load + validate every referenced student and product up front so the
    // draft is atomic: either all items resolve or none is written. Track the
    // frozen snapshot + courseId per item so the create below is a single tx.
    const resolvedItems: Array<{
      studentId: string;
      productId: string;
      courseId: string;
      snapshot: ReturnType<typeof freezeItemSnapshot>;
    }> = [];
    for (const line of command.items) {
      const student = await this.db.studentProfile.findUnique({
        where: { id: line.studentId },
      });
      if (!student) {
        throw BusinessError.notFound('Student not found', { studentId: line.studentId });
      }
      const product = await this.db.packageProduct.findUnique({
        where: { id: line.productId },
      });
      if (!product) {
        throw BusinessError.notFound('Package product not found', {
          productId: line.productId,
        });
      }
      if (product.status !== CATALOG_STATUS.ACTIVE) {
        throw BusinessError.conflict('Package product is not active', {
          productId: line.productId,
          status: product.status,
        });
      }
      resolvedItems.push({
        studentId: line.studentId,
        productId: line.productId,
        courseId: product.courseId,
        snapshot: freezeItemSnapshot(product),
      });
    }

    // Σ unitPriceSnapshot as Prisma.Decimal (2-dp). Compute total with Decimal
    // addition — never JS number — and store on the order row.
    const totalAmount = resolvedItems.reduce(
      (acc, it) => acc.plus(it.snapshot.unitPriceSnapshot),
      new Prisma.Decimal('0.00'),
    );

    const created = await this.db.offlineOrder.create({
      data: {
        buyerAccountId: command.buyerAccountId,
        status: OFFLINE_ORDER_STATUS.PENDING,
        totalAmount,
        items: {
          create: resolvedItems.map((it) => ({
            studentId: it.studentId,
            productId: it.productId,
            courseId: it.courseId,
            productNameSnapshot: it.snapshot.productNameSnapshot,
            unitPriceSnapshot: it.snapshot.unitPriceSnapshot,
            hoursSnapshot: it.snapshot.hoursSnapshot,
            validDaysSnapshot: it.snapshot.validDaysSnapshot,
          })),
        },
      },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });

    void adminId; // adminId is conveyed via CommandContext on mutations; drafts are not idempotency-gated here.
    return toOrderDto(created);
  }

  // ── confirm ────────────────────────────────────────────────────────────

  /**
   * Confirm a PENDING order. Idempotent on `context.idempotencyKey`. In ONE
   * transaction (provided by IdempotencyService): for each item, create the
   * CoursePackage, post the GRANT into the ledger on the same tx, then flip the
   * order to CONFIRMED and stamp confirmedAt. Reads item SNAPSHOTS (never the
   * live product), so the confirmed price/hours equal the frozen values.
   */
  async confirm(orderId: string, context: CommandContext): Promise<OfflineOrderDto> {
    const request: IdempotentRequest = {
      scope: 'order-confirm',
      actorId: context.actorId,
      key: context.idempotencyKey,
      requestHash: stableHash({ orderId, intent: 'confirm' }),
    };
    return this.idempotency.execute<OfflineOrderDto>(request, (tx) =>
      this.confirmInTx(tx, orderId),
    );
  }

  private async confirmInTx(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<OfflineOrderDto> {
    // Acquire a record lock on the order row FOR UPDATE as the FIRST statement
    // in the tx, reading the CURRENT (latest committed) status. The order
    // always EXISTS when being confirmed (created at draft), so InnoDB takes a
    // RECORD lock (not a gap lock) — this cannot deadlock with other ops on
    // existing rows. This serializes two operations on the SAME order that
    // carry DIFFERENT idempotency keys (e.g. confirm key-A + void key-B fired
    // concurrently): IdempotencyService only dedups the SAME-key case, so
    // without this lock both would read PENDING under RR and race. The lock
    // makes the second wait until the first tx commits; the locking read then
    // observes the winner's new status and the state-machine guard rejects the
    // transition.
    //
    // We MUST assert against the value from the locking read (current data),
    // NOT a subsequent plain findUnique: under MySQL REPEATABLE READ a
    // non-locking read uses the trx snapshot, which can still hold the stale
    // pre-winner status and would let the loser's guard pass.
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM \`offline_order\` WHERE id = ${orderId} FOR UPDATE
    `;
    if (locked.length === 0) {
      throw BusinessError.notFound('Order not found', { orderId });
    }
    assertCanConfirm(locked[0]!.status);

    const order = await tx.offlineOrder.findUnique({
      where: { id: orderId },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) {
      // Should be unreachable given the lock above; guard anyway.
      throw BusinessError.notFound('Order not found', { orderId });
    }

    const confirmedAt = new Date();
    // Shanghai-local confirm date for startsOn (a @db.Date — stored without TZ,
    // so use the Shanghai date-of-month). Inclusive expiry: validDays - 1 means
    // a 30-day package confirmed 7/23 expires 8/21 (7/23 is day 1, +29 = 8/21).
    const startsOnDate = toShanghaiDateOnly(confirmedAt);

    for (const item of order.items) {
      // EXPIRY computed from the frozen validDaysSnapshot via inclusive semantics.
      const expiresOn = calculateExpiryDate(confirmedAt, item.validDaysSnapshot - 1);

      // 1. Create the CoursePackage for this item on the SAME tx. The package
      //    starts with `granted` = hoursSnapshot (the total authorised by this
      //    order item) but `available` = 0: per the M1 invariant, balance
      //    changes flow ONLY through append-only postings. The grant below
      //    lands the units into `available` (package + summary balance) so the
      //    package reconciles against its allocation history. Pre-seeding
      //    `available` here would double-count the grant.
      const pkg = await tx.coursePackage.create({
        data: {
          studentId: item.studentId,
          courseId: item.courseId,
          sourceType: 'ORDER',
          sourceOrderItemId: item.id,
          startsOn: startsOnDate,
          expiresOn: new Date(`${expiresOn}T00:00:00.000Z`),
          granted: item.hoursSnapshot,
          available: 0,
          reserved: 0,
          consumed: 0,
          expired: 0,
          status: 'ACTIVE',
        },
      });

      // 2. Post the GRANT on the SAME tx, passing the just-created package's
      //    id. grantOrder appends the HourTransaction + HourAllocation and
      //    updates the balance; all under this tx so a failure rolls back the
      //    package too.
      await this.ledger.grantOrder(tx, {
        orderId,
        orderItemId: item.id,
        studentId: item.studentId,
        courseId: item.courseId,
        packageId: pkg.id,
        units: item.hoursSnapshot.toFixed(2),
        occurredAt: confirmedAt,
        businessKey: `order-grant:${item.id}`,
      });
    }

    // 3. Flip the order to CONFIRMED + stamp confirmedAt on the SAME tx.
    const updated = await tx.offlineOrder.update({
      where: { id: orderId },
      data: {
        status: OFFLINE_ORDER_STATUS.CONFIRMED,
        confirmedAt,
      },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            coursePackage: {
              select: {
                id: true,
                allocations: { select: { transactionId: true }, orderBy: { createdAt: 'asc' } },
              },
            },
          },
        },
      },
    });
    return toOrderDto(updated);
  }

  // ── void (draft) ───────────────────────────────────────────────────────

  /**
   * Void a PENDING draft. The schema has no VOIDED status, and a draft has no
   * packages/grants, so voiding removes the draft and its items. Idempotent on
   * `context.idempotencyKey`. CONFIRMED/REVERSED orders are rejected.
   *
   * Returns a serializable {@link VoidDraftResult} (not `void`) so the result
   * is non-null JSON in the idempotency record — that is what makes a client
   * retry (same key, after the row is already deleted) replay the cached 200
   * instead of re-running the work and hitting a 404.
   */
  async voidDraft(orderId: string, context: CommandContext): Promise<VoidDraftResult> {
    const request: IdempotentRequest = {
      scope: 'order-void',
      actorId: context.actorId,
      key: context.idempotencyKey,
      requestHash: stableHash({ orderId, intent: 'void' }),
    };
    return this.idempotency.execute<VoidDraftResult>(request, (tx) =>
      this.voidInTx(tx, orderId),
    );
  }

  private async voidInTx(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<VoidDraftResult> {
    // Lock the order row FOR UPDATE (record lock — the order always EXISTS
    // when being voided, so InnoDB takes a record lock, not a gap lock, and
    // cannot deadlock with other operations on existing rows). This is the
    // FIRST statement in the tx so that two operations on the same order with
    // DIFFERENT idempotency keys (e.g. confirm key-A + void key-B) serialize
    // regardless of the in-process IdempotencyService dedup, which only covers
    // the SAME-key case. The status read here is CURRENT data; assert against
    // it (NOT a subsequent snapshot read) — see confirmInTx.
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM \`offline_order\` WHERE id = ${orderId} FOR UPDATE
    `;
    if (locked.length === 0) {
      throw BusinessError.notFound('Order not found', { orderId });
    }
    assertCanVoid(locked[0]!.status);

    const order = await tx.offlineOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) {
      throw BusinessError.notFound('Order not found', { orderId });
    }

    // A PENDING draft has no CoursePackages (they're created at confirm), so
    // deleting its items is safe (no CoursePackage.sourceOrderItemId references
    // them). Remove items first, then the order, to satisfy onDelete: Restrict.
    await tx.orderItem.deleteMany({ where: { orderId } });
    await tx.offlineOrder.delete({ where: { id: orderId } });

    // Non-null serializable marker so idempotent replay returns the cached 200
    // rather than re-running against an already-deleted row (which would 404).
    return { voided: true, orderId };
  }

  // ── reverse ────────────────────────────────────────────────────────────

  /**
   * Reverse a CONFIRMED order. Idempotent on `context.idempotencyKey`. In ONE
   * tx: for each item's package, enforce the STRICT reversal rule (no posting
   * after the GRANT — else `ORDER_NOT_REVERSIBLE` 409), then append a REVERSAL
   * via {@link HourLedgerService.reverseOrder}; finally flip the order to
   * REVERSED. The original GRANT is never mutated.
   */
  async reverse(
    orderId: string,
    command: ReverseOfflineOrderCommand,
    context: CommandContext,
  ): Promise<OfflineOrderDto> {
    const reason = (command.reason ?? 'Offline order reversal').slice(0, 1000);
    const request: IdempotentRequest = {
      scope: 'order-reverse',
      actorId: context.actorId,
      key: context.idempotencyKey,
      requestHash: stableHash({ orderId, intent: 'reverse', reason }),
    };
    return this.idempotency.execute<OfflineOrderDto>(request, (tx) =>
      this.reverseInTx(tx, orderId, reason),
    );
  }

  private async reverseInTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    reason: string,
  ): Promise<OfflineOrderDto> {
    // Acquire a record lock on the order row FOR UPDATE as the FIRST statement
    // in the tx (record lock — the order always EXISTS when being reversed).
    // Serializes same-order operations that carry DIFFERENT idempotency keys;
    // see {@link confirmInTx} for the rationale. Assert against the CURRENT
    // status from this locking read (NOT a snapshot read).
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM \`offline_order\` WHERE id = ${orderId} FOR UPDATE
    `;
    if (locked.length === 0) {
      throw BusinessError.notFound('Order not found', { orderId });
    }
    assertCanReverse(locked[0]!.status);

    const order = await tx.offlineOrder.findUnique({
      where: { id: orderId },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) {
      throw BusinessError.notFound('Order not found', { orderId });
    }

    const occurredAt = new Date();

    for (const item of order.items) {
      // Resolve the package created at confirm time for this item.
      const pkg = await tx.coursePackage.findUnique({
        where: { sourceOrderItemId: item.id },
        include: { allocations: { orderBy: { createdAt: 'asc' } } },
      });
      if (!pkg) {
        // Inconsistent: CONFIRMED but no package. Treat as not reversible.
        throw new BusinessError(
          ERROR_CODES.ORDER_NOT_REVERSIBLE,
          'Order item has no granted package to reverse',
          HTTP_STATUS.CONFLICT,
          { orderId, orderItemId: item.id },
        );
      }

      // STRICT reversal: the GRANT created exactly one HourAllocation against
      // this package. If any OTHER allocation exists (a later consumption or
      // manual adjustment from Task 10), reversing would corrupt the ledger —
      // refuse with ORDER_NOT_REVERSIBLE. The original GRANT transaction is
      // allocations[0]; a downstream posting adds allocations[1+].
      if (pkg.allocations.length !== 1) {
        throw new BusinessError(
          ERROR_CODES.ORDER_NOT_REVERSIBLE,
          'Order cannot be reversed: its package has postings after the grant',
          HTTP_STATUS.CONFLICT,
          { orderId, packageId: pkg.id, allocations: pkg.allocations.length },
        );
      }
      const grantAllocation = pkg.allocations[0]!;

      // Append the REVERSAL on the SAME tx, pointing at the original GRANT.
      await this.ledger.reverseOrder(tx, {
        orderId,
        orderItemId: item.id,
        originalTransactionId: grantAllocation.transactionId,
        occurredAt,
        businessKey: `order-reverse:${item.id}`,
        reason,
      });
    }

    const updated = await tx.offlineOrder.update({
      where: { id: orderId },
      data: { status: OFFLINE_ORDER_STATUS.REVERSED },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            coursePackage: {
              select: {
                id: true,
                allocations: { select: { transactionId: true }, orderBy: { createdAt: 'asc' } },
              },
            },
          },
        },
      },
    });
    return toOrderDto(updated);
  }
}

// ── Module-private helpers ─────────────────────────────────────────────────

/**
 * Build a deterministic request hash for an idempotency key. Two requests that
 * carry the same key MUST carry the same body (per the idempotency contract); a
 * mismatched hash surfaces as `IDEMPOTENCY_KEY_REUSED` (409). We hash a stable
 * JSON of the identifying fields so the same logical intent always hashes the
 * same regardless of object key order.
 */
function stableHash(value: Record<string, unknown>): string {
  const json = JSON.stringify(sortKeys(value));
  // Simple FNV-1a (32-bit) over the UTF-8 bytes. Not cryptographic — its only
  // job is to be deterministic and collision-rare for the identifying tuple.
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Render a UTC instant as a Shanghai-local `YYYY-MM-DD` and parse it back to a
 * `Date` at UTC midnight for the `@db.Date`-typed `startsOn` column. The schema
 * stores date-only columns without timezone, so we anchor at UTC 00:00 to keep
 * the year/month/day we computed for Shanghai.
 */
function toShanghaiDateOnly(utc: Date): Date {
  const shanghai = toShanghaiDateString(utc); // 'YYYY-MM-DD'
  return new Date(`${shanghai}T00:00:00.000Z`);
}
