import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
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
 * it (`OrdersModule`) provides its own instance, so a root-scoped copy would be
 * dead (never resolved). Removed during the Task 9 fix wave.
 */
@Module({
  imports: [PrismaModule, IdentityModule, CatalogModule, HoursModule, OrdersModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
