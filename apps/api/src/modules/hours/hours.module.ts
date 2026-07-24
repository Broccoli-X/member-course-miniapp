import { Module } from '@nestjs/common';
import { HourLedgerService } from './application/hour-ledger.service.js';
import { HourExpirationService } from './application/hour-expiration.service.js';
import { HourLockRepository } from './infrastructure/hour-lock.repository.js';
import { HourExpirationJob } from './infrastructure/hour-expiration.job.js';
import { HourAdminController } from './presentation/admin/hour-admin.controller.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { IdentityModule } from '../identity/identity.module.js';

/**
 * Hours feature module — the append-only lesson-hour ledger.
 *
 * Owns the two admin-only manual-adjustment endpoints under
 * `admin/v1/students/:studentId/courses/:courseId/hour-adjustments` (Task 10),
 * plus the daily-expiration job. `grantOrder`/`reverseOrder` remain on
 * {@link HourLedgerService} for the Orders module (Task 9) to call inside its
 * own transaction; `HoursModule` exports the service so `OrdersModule` can
 * inject it directly.
 *
 * {@link IdentityModule} is imported so the {@link AdminAuthGuard} on
 * {@link HourAdminController} can resolve its `JwtService` dependency (the same
 * pattern `OrdersModule` uses for its admin controller).
 *
 * `PrismaService` is `@Global` so no PrismaModule import is needed.
 * {@link IdempotencyService} is declared as a provider HERE (it depends only
 * on the global PrismaService) so this module is self-contained for DI — the
 * same per-module-instance pattern `OrdersModule` uses. The DB unique
 * constraint is the cross-instance backstop, so a fresh instance is fine for
 * this module's own ops.
 *
 * The {@link HourExpirationJob} cron is registered here so it boots with the
 * app once `ScheduleModule.forRoot()` (registered once in `AppModule`) is
 * active.
 */
@Module({
  imports: [IdentityModule],
  controllers: [HourAdminController],
  providers: [
    HourLedgerService,
    HourExpirationService,
    HourLockRepository,
    HourExpirationJob,
    IdempotencyService,
  ],
  exports: [HourLedgerService, HourLockRepository],
})
export class HoursModule {}
