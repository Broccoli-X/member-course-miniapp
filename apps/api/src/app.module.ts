import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { TraceIdMiddleware } from './common/http/trace-id.middleware.js';
import { IdempotencyService } from './common/idempotency/idempotency.service.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { HoursModule } from './modules/hours/hours.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';

@Module({
  imports: [PrismaModule, IdentityModule, CatalogModule, HoursModule, OrdersModule],
  controllers: [HealthController],
  providers: [IdempotencyService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
