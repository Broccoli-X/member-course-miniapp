import { Module } from '@nestjs/common';
import { HourLedgerService } from './application/hour-ledger.service.js';
import { HourLockRepository } from './infrastructure/hour-lock.repository.js';

/**
 * Hours feature module — the append-only lesson-hour ledger.
 *
 * M1 has NO HTTP surface here: this module is consumed by the Orders module
 * (Task 9) and the Adjustments module (Task 10), which call
 * `HourLedgerService.grantOrder` / `reverseOrder` inside their own
 * transactions. `PrismaService` is `@Global` so no PrismaModule import is
 * needed.
 *
 * Both the service and the lock repository are exported so downstream modules
 * can inject them directly (the Orders module will need the lock repository
 * only in unusual cases; the service is the primary surface).
 */
@Module({
  providers: [HourLedgerService, HourLockRepository],
  exports: [HourLedgerService, HourLockRepository],
})
export class HoursModule {}
