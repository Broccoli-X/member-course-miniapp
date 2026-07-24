import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { HoursModule } from '../hours/hours.module.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { OfflineOrderAdminController } from './presentation/admin/offline-order-admin.controller.js';
import { OfflineOrderMiniController } from './presentation/mini/offline-order-mini.controller.js';
import { OfflineOrderService } from './application/offline-order.service.js';
import { OfflineOrderQueryService } from './application/offline-order-query.service.js';

/**
 * Offline order feature module (Task 9 + Task 11 mini reads).
 *
 * Owns the six admin-only order endpoints under `admin/v1/orders` (Task 9) and
 * the two member read endpoints under `mini/v1/orders` (Task 11). The
 * {@link AdminAuthGuard} / {@link MiniAuthGuard} / {@link BoundMemberGuard}
 * come from {@link IdentityModule} (which provides the `JwtModule` the guards
 * need). {@link HoursModule} exports {@link HourLedgerService}, which
 * confirm/reverse invoke INSIDE the order transaction so package creation +
 * ledger posting + order-status flip share one atomic tx. `PrismaService` is
 * `@Global`. {@link IdempotencyService} is declared as a provider here (it
 * depends only on the global PrismaService) so this module is self-contained
 * for DI.
 *
 * There is no mini-program order CREATION (M1 global constraint — no mini order
 * creation, online payment, or refund); the mini surface added here is
 * read-only.
 */
@Module({
  imports: [IdentityModule, HoursModule],
  controllers: [OfflineOrderAdminController, OfflineOrderMiniController],
  providers: [OfflineOrderService, OfflineOrderQueryService, IdempotencyService],
})
export class OrdersModule {}
