import { Injectable, Logger } from '@nestjs/common';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { ExpireBatchResult } from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { HourLedgerService } from './hour-ledger.service.js';

/**
 * `HourExpirationService` — the daily lesson-hour expiry runner (Task 10).
 *
 * `expireDuePackages(now, batchSize)` finds `CoursePackage` rows that are due
 * for expiry as of `now` and, for each, opens a dedicated locked transaction
 * and calls {@link HourLedgerService.expireAvailable} with a deterministic
 * businessKey `expiry:<packageId>:<businessDate>`. The deterministic key is
 * what makes the job idempotent across reruns: a second run on the same
 * business date hits the existing `HourTransaction.businessKey` and replays
 * the cached result (zero side effects, zero double-count).
 *
 * ## The 00:05 Shanghai gate (and the verbatim boundary test)
 *
 * The cron fires at 00:05 Asia/Shanghai daily. The brief's boundary test calls
 * `expireDuePackages(now, batchSize)` directly with two `now` values and
 * expects different results:
 *
 *   - `now = 2026-08-01T16:04:59Z` (Shanghai 2026-08-02 00:04:59, BEFORE 00:05)
 *     → no expiry (`expiredUnits === '0.00'`)
 *   - `now = 2026-08-01T16:05:00Z` (Shanghai 2026-08-02 00:05:00, AT 00:05)
 *     → expiry runs (`expiredUnits === '2.00'`)
 *
 * Because the test calls the SERVICE directly (not the cron), the 00:05 gate
 * MUST live in this service for the test to pass: `expireDuePackages` exits
 * early with `{scanned:0, processed:0, failed:0}` when `now`'s Shanghai time
 * is before 00:05. The cron itself just forwards `new Date()`.
 *
 * ## "expiresOn before today" semantics
 *
 * A package with `expiresOn = 2026-08-01` is due on the 00:05 run of
 * 2026-08-02 (Shanghai): `expiresOn (2026-08-01) < today (2026-08-02)`. The
 * expiry date is INCLUSIVE of its last day — a package expiring 2026-08-01 is
 * still usable through end-of-day 2026-08-01 and expires at the next day's
 * 00:05 run.
 *
 * ## Per-package failure isolation
 *
 * One bad package (e.g. a stale row, a transient lock conflict) does NOT abort
 * the batch: each package's expiry is wrapped in its own try/catch inside its
 * own transaction, and the error is logged + counted into `failed`. The batch
 * returns `{ scanned, processed, failed }` so the caller (cron/ops) can alert
 * on `failed > 0`.
 */
@Injectable()
export class HourExpirationService {
  private readonly logger = new Logger(HourExpirationService.name);
  private static readonly SHANGHAI_TZ = 'Asia/Shanghai';
  /** Cron fires at 5 minutes past midnight; expiry only runs at/after that. */
  private static readonly EXPIRY_MINUTE_OF_DAY = 5;

  constructor(
    private readonly db: PrismaService,
    private readonly ledger: HourLedgerService,
  ) {}

  async expireDuePackages(now: Date, batchSize: number): Promise<ExpireBatchResult> {
    const result: ExpireBatchResult = { scanned: 0, processed: 0, failed: 0 };

    // ── 00:05 Shanghai gate ──
    // The boundary test calls this service directly with `now` and expects no
    // expiry before 00:05 Shanghai. If the Shanghai-local time of `now` is
    // before 00:05, exit with zeros without scanning.
    const shanghaiNow = toZonedTime(now, HourExpirationService.SHANGHAI_TZ);
    const shanghaiMinutes = shanghaiNow.getHours() * 60 + shanghaiNow.getMinutes();
    if (shanghaiMinutes < HourExpirationService.EXPIRY_MINUTE_OF_DAY) {
      return result;
    }

    // today = the Shanghai YYYY-MM-DD of `now` — the cutoff for expiresOn < today.
    const businessDate = format(shanghaiNow, 'yyyy-MM-dd');
    const todayDate = new Date(`${businessDate}T00:00:00.000Z`);

    // Scan packages due for expiry: ACTIVE, available > 0, expiresOn < today.
    // Order by expiresOn so the oldest packages are expired first within a
    // capped batch (limit `batchSize`). We read-only here; locking happens in
    // the per-package tx below.
    const due = await this.db.coursePackage.findMany({
      where: {
        status: 'ACTIVE',
        available: { gt: 0 },
        expiresOn: { lt: todayDate },
      },
      select: { id: true, studentId: true, courseId: true, expiresOn: true },
      orderBy: { expiresOn: 'asc' },
      take: Math.max(1, Math.floor(batchSize)),
    });
    result.scanned = due.length;

    for (const pkg of due) {
      // Deterministic businessKey — idempotent across reruns on the same
      // business date. A second run finds the existing HourTransaction and
      // replays it with zero side effects (no double-count of expiredUnits).
      const businessKey = `expiry:${pkg.id}:${businessDate}`;
      try {
        await this.db.$transaction((tx) =>
          this.ledger.expireAvailable(tx, pkg.id, businessKey),
        );
        result.processed += 1;
      } catch (err) {
        // Per-package failure isolation: log + count, keep going. A lock
        // conflict or a transient error on one package must not abort the
        // whole batch.
        result.failed += 1;
        this.logger.error(
          `Failed to expire package ${pkg.id} (businessKey=${businessKey}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return result;
  }
}
