import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  buckets,
  type Buckets,
} from '../domain/hour-buckets.js';

/**
 * `HourLockRepository` — the ONLY place raw SQL lives in the hours module.
 *
 * Both `grantOrder` and `reverseOrder` must serialize concurrent postings for
 * the same (studentId, courseId). We do that by taking InnoDB row locks
 * (`SELECT ... FOR UPDATE`) on the rows we are about to mutate, INSIDE the
 * caller's transaction. The lock order is fixed by the brief:
 *
 *     1. `StudentCourseBalance` row for (studentId, courseId)
 *     2. the eligible `CoursePackage` rows (ordered by FEFO so the lock order
 *        matches the allocation order — no cross-deadlock between two
 *        concurrent postings racing for the same packages)
 *
 * ## The first-grant deadlock trap (and how we avoid it)
 *
 * Under MySQL's default REPEATABLE READ isolation, `SELECT ... FOR UPDATE` on a
 * row that DOES NOT EXIST takes a gap lock, not a record lock. Two concurrent
 * "first grants" for the same (studentId, courseId) — neither balance row
 * exists yet — would each hold a gap lock on the gap where the row would be,
 * and then both attempt an INSERT; each INSERT waits on the other's gap lock →
 * classic deadlock, one transaction is the victim. (Task 6 hit exactly this
 * with account rows.)
 *
 * Fix: never lock a not-yet-existing balance row with FOR UPDATE. Instead use
 * `INSERT ... ON DUPLICATE KEY UPDATE` to atomically create-or-touch the row,
 * then lock it. The `@@unique([studentId, courseId])` index is what makes the
 * ON DUPLICATE KEY branch fire; whichever concurrent transaction's INSERT
 * lands first owns the row, the other's INSERT becomes a no-op UPDATE (which
 * still takes the X lock on the existing row — exactly what we want). The
 * creators are serialized by the unique index, never by a gap lock. After the
 * upsert, a plain `SELECT ... FOR UPDATE` re-reads the (now guaranteed to
 * exist) row so we have its current bucket values under the X lock.
 *
 * This repository does NOT mutate the balance or package rows — it only locks
 * them and returns their current values. The `HourLedgerService` performs the
 * actual updates via Prisma (so the version increment + bucket deltas are
 * visible in the Prisma query log). Keeping "lock" separate from "update"
 * makes the lock surface auditable in one place.
 */

/** Raw row shape returned by MySQL for the balance lock. */
interface RawBalanceRow {
  id: string;
  available: Prisma.Decimal;
  reserved: Prisma.Decimal;
  consumed: Prisma.Decimal;
  expired: Prisma.Decimal;
  version: number;
}

/** Raw row shape returned by MySQL for the package lock. */
export interface RawPackageRow {
  id: string;
  studentId: string;
  courseId: string;
  sourceType: string;
  sourceOrderItemId: string | null;
  startsOn: Date;
  expiresOn: Date;
  granted: Prisma.Decimal;
  available: Prisma.Decimal;
  reserved: Prisma.Decimal;
  consumed: Prisma.Decimal;
  expired: Prisma.Decimal;
  status: string;
  createdAt: Date;
  version: number;
}

/** A balance row + its buckets, ready for the service to apply deltas to. */
export interface LockedBalance {
  id: string;
  buckets: Buckets;
  version: number;
}

/** A locked package row projected to the fields the service / allocator need. */
export interface LockedPackage {
  id: string;
  sourceType: string;
  sourceOrderItemId: string | null;
  startsOn: Date;
  expiresOn: Date;
  createdAt: Date;
  buckets: Buckets;
  version: number;
  status: string;
}

@Injectable()
export class HourLockRepository {
  /**
   * Lock the `StudentCourseBalance` row for (studentId, courseId), creating it
   * (zeroed) if it does not yet exist. Always returns the row under an X lock
   * held until the surrounding transaction commits/aborts.
   *
   * Strategy (the brief's recommended "create-or-lock" pattern):
   *
   *   1. `INSERT ... ON DUPLICATE KEY UPDATE version = version` — atomically
   *      creates the row if absent, or no-op-touches it (still taking the X
   *      lock on the existing row) if present. The `@@unique([studentId,
   *      courseId])` index routes a conflicting INSERT to the UPDATE branch.
   *   2. `SELECT ... FOR UPDATE` — re-reads the now-guaranteed-to-exist row
   *      under an X record lock.
   *
   * WHY this is deadlock-free for the first-grant race (the trap Task 6 hit):
   *
   *   - `SELECT ... FOR UPDATE` on an absent row under MySQL's default RR
   *     takes a GAP lock; two concurrent first-grants each hold a gap lock on
   *     the same gap and then each try an INSERT — classic deadlock (P2034).
   *
   *   - `INSERT ... ON DUPLICATE KEY UPDATE` does NOT take gap locks on the
   *     "row exists" branch — it takes a record lock on the existing row. On
   *     the "row absent" branch it takes an INSERT INTENTION lock, which does
   *     NOT conflict with other insert intention locks (only with gap locks).
   *     So two concurrent first-grants: the winner's INSERT lands and creates
   *     the row; the loser's INSERT waits on the unique index for the winner
   *     to commit, then takes the UPDATE branch (no-op) + record lock. No
   *     gap locks, no deadlock. The unique index is the serialization point.
   *
   *   - Because step 2 only ever runs after the row is guaranteed to exist
   *     (step 1 created-or-touched it inside this same tx), the FOR UPDATE in
   *     step 2 takes a record lock, not a gap lock. There is never a "FOR
   *     UPDATE on absent row" path.
   */
  async lockBalance(
    tx: Prisma.TransactionClient,
    studentId: string,
    courseId: string,
  ): Promise<LockedBalance> {
    // 1. Atomically create-or-touch. `version = version` is a no-op
    //    self-assignment that still takes the X lock on the existing row in
    //    the UPDATE branch. NOTE: `updatedAt` is supplied explicitly because
    //    Prisma's `@updatedAt` is a CLIENT-side mechanism — the column has no
    //    DB default (see the migration DDL), so a raw INSERT omitting it
    //    would fail. `createdAt` IS defaulted (CURRENT_TIMESTAMP(3)).
    //    UTC_TIMESTAMP(3) matches the rest of the schema's UTC convention.
    await tx.$executeRaw`
      INSERT INTO \`student_course_balance\`
        (\`id\`, \`studentId\`, \`courseId\`,
         \`available\`, \`reserved\`, \`consumed\`, \`expired\`,
         \`updatedAt\`, \`version\`)
      VALUES
        (${cryptoRandomId()}, ${studentId}, ${courseId},
         0, 0, 0, 0,
         UTC_TIMESTAMP(3), 1)
      ON DUPLICATE KEY UPDATE \`version\` = \`version\`
    `;

    // 2. Re-read under FOR UPDATE. The row is guaranteed to exist (step 1
    //    created-or-touched it inside this tx), so this takes a record lock,
    //    not a gap lock. FOR UPDATE reads the latest committed version (it's
    //    a locking read, not a snapshot read), so even if another tx created
    //    the row and we hit the UPDATE branch, we read THAT row's true state.
    const rows = await tx.$queryRaw<RawBalanceRow[]>`
      SELECT \`id\`, \`available\`, \`reserved\`, \`consumed\`, \`expired\`, \`version\`
      FROM \`student_course_balance\`
      WHERE \`studentId\` = ${studentId} AND \`courseId\` = ${courseId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      // Unreachable (we just created-or-touched it in this same tx). Hard error.
      throw new Error(
        `HourLockRepository: balance row missing after create-or-touch for student=${studentId} course=${courseId}`,
      );
    }
    return {
      id: row.id,
      buckets: buckets(row.available, row.reserved, row.consumed, row.expired),
      version: row.version,
    };
  }

  /**
   * Lock the given `CoursePackage` rows by id, returning them in FEFO order
   * (expiresOn ASC, createdAt ASC, id ASC) so callers allocate in lock-order.
   * Uses `SELECT ... FOR UPDATE` on the package PKs. The id list is
   * caller-provided (the service computes which packages are eligible before
   * locking) — but we ORDER BY the FEFO columns in the SQL itself so the
   * result ordering is deterministic at the DB, not dependent on the input.
   *
   * Empty `packageIds` → returns [] (no rows to lock).
   */
  async lockPackages(
    tx: Prisma.TransactionClient,
    packageIds: readonly string[],
  ): Promise<LockedPackage[]> {
    if (packageIds.length === 0) return [];

    // Prisma's tagged-template raw SQL does NOT support IN-list expansion, so
    // build the placeholder list explicitly. Values are uuid strings supplied
    // by the service (never user input), and we hand them as parameters to
    // `$queryRawUnsafe` so they are still bound, not string-interpolated.
    const placeholders = packageIds.map(() => '?').join(', ');
    const rows = await tx.$queryRawUnsafe<RawPackageRow[]>(
      `SELECT \`id\`, \`studentId\`, \`courseId\`, \`sourceType\`, \`sourceOrderItemId\`,
              \`startsOn\`, \`expiresOn\`, \`granted\`, \`available\`, \`reserved\`,
              \`consumed\`, \`expired\`, \`status\`, \`createdAt\`, \`version\`
       FROM \`course_package\`
       WHERE \`id\` IN (${placeholders})
       ORDER BY \`expiresOn\` ASC, \`createdAt\` ASC, \`id\` ASC
       FOR UPDATE`,
      ...packageIds,
    );
    return rows.map((row) => ({
      id: row.id,
      sourceType: row.sourceType,
      sourceOrderItemId: row.sourceOrderItemId,
      startsOn: row.startsOn,
      expiresOn: row.expiresOn,
      createdAt: row.createdAt,
      buckets: buckets(row.available, row.reserved, row.consumed, row.expired),
      version: row.version,
      status: row.status,
    }));
  }

  /**
   * Lock a single package by id (FOR UPDATE). Used by `reverseOrder` to lock
   * the package the original grant landed in. Returns null when the row is
   * absent (the service decides whether that's an error).
   */
  async lockPackageById(
    tx: Prisma.TransactionClient,
    packageId: string,
  ): Promise<LockedPackage | null> {
    const [row] = await this.lockPackages(tx, [packageId]);
    return row ?? null;
  }
}

/**
 * Generate a v4 uuid for the balance create-or-touch INSERT.
 * `crypto.randomUUID()` is always available on Node 19+ (we run on Node 22+).
 * If it is somehow missing the runtime is misconfigured and producing weaker
 * IDs silently would be worse than failing loudly — this is an accounting
 * path, so throw instead of falling back to a manual `Math.random()` build.
 */
function cryptoRandomId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  throw new Error('crypto.randomUUID is not available');
}
