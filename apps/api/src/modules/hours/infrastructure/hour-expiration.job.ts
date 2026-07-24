import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HourExpirationService } from '../application/hour-expiration.service.js';

/**
 * `HourExpirationJob` — the daily lesson-hour expiry cron (Task 10).
 *
 * Fires at `00:05 Asia/Shanghai` every day and delegates to
 * {@link HourExpirationService.expireDuePackages} with `now = new Date()`. The
 * cron expression `5 0 * * *` (minute 5, hour 0, every day-of-month and
 * day-of-week) combined with `timeZone: 'Asia/Shanghai'` makes the schedule
 * fire at exactly 00:05 Shanghai local time regardless of the host's TZ.
 *
 * The 00:05 offset (vs. midnight) is deliberate: M1 stores `expiresOn` as an
 * inclusive date, so a package expiring 2026-08-01 is still usable through
 * end-of-day 2026-08-01 Shanghai. Expiring at 00:05 the NEXT day (2026-08-02)
 * gives a 5-minute buffer past midnight for any late-day bookings to settle
 * before the package is flipped to expired. The
 * {@link HourExpirationService} independently re-checks the 00:05 gate on the
 * `now` it receives so a direct test invocation (bypassing the cron) still
 * honors the same boundary.
 *
 * `waitForCompletion: true` prevents overlapping runs — if a run takes longer
 * than 24h (it will not), the next scheduled fire is skipped rather than
 * piling up. `batchSize` caps the per-run package count so a huge backlog
 * degrades gracefully (the next day's run picks up the rest).
 *
 * TESTING: the cron itself is NOT exercised by the integration tests (real
 * cron timing is flaky in CI). The tests call
 * `HourExpirationService.expireDuePackages(now, batchSize)` directly with a
 * fixed `now` so the 00:05 boundary is deterministic.
 */
@Injectable()
export class HourExpirationJob {
  private readonly logger = new Logger(HourExpirationJob.name);
  /** Per-run cap on packages expired. Sized to clear a typical day with headroom. */
  private static readonly DEFAULT_BATCH_SIZE = 500;

  constructor(private readonly expiration: HourExpirationService) {}

  @Cron('5 0 * * *', {
    timeZone: 'Asia/Shanghai',
    waitForCompletion: true,
    name: 'hour-expiration',
  })
  async runDailyExpiration(): Promise<void> {
    const startedAt = new Date();
    this.logger.log(`Hour expiration job fired at ${startedAt.toISOString()}`);
    try {
      const result = await this.expiration.expireDuePackages(
        startedAt,
        HourExpirationJob.DEFAULT_BATCH_SIZE,
      );
      this.logger.log(
        `Hour expiration job complete: scanned=${result.scanned} ` +
          `processed=${result.processed} failed=${result.failed}`,
      );
    } catch (err) {
      // The service isolates per-package failures; reaching here means the
      // batch itself threw unexpectedly. Log and let the scheduler retry
      // tomorrow (no in-process retry in M1).
      this.logger.error(
        `Hour expiration job failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
