import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { TraceIdMiddleware } from './common/http/trace-id.middleware.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { HoursModule } from './modules/hours/hours.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';

/**
 * `IdempotencyService` is NOT a root provider here: only `HealthController`
 * lives at this scope and it doesn't inject it. Each feature module that needs
 * it (`OrdersModule`, `HoursModule`) provides its own instance, so a
 * root-scoped copy would be dead (never resolved). Removed during the Task 9
 * fix wave; HoursModule followed the same pattern in Task 10.
 *
 * `ScheduleModule.forRoot()` is registered EXACTLY ONCE here (Task 10). It
 * boots the cron orchestrator; the {@link HourExpirationJob} (provided in
 * `HoursModule`) is discovered by the scheduler and registered automatically.
 */
@Module({
  imports: [
    PrismaModule,
    ScheduleModule.forRoot(),
    IdentityModule,
    CatalogModule,
    HoursModule,
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
