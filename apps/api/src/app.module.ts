import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { TraceIdMiddleware } from './common/http/trace-id.middleware.js';
import { IdempotencyService } from './common/idempotency/idempotency.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [IdempotencyService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
