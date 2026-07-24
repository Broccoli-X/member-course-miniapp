import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogAdminController } from './presentation/admin/catalog-admin.controller.js';
import { CatalogMiniController } from './presentation/mini/catalog-mini.controller.js';
import { CatalogCommandService } from './application/catalog-command.service.js';
import { CatalogQueryService } from './application/catalog-query.service.js';

/**
 * Course and package catalog feature module.
 *
 * Owns the 9 CRUD/archive catalog endpoints (7 admin + 2 mini). The guards
 * (`AdminAuthGuard`, `MiniAuthGuard`, `BoundMemberGuard`) are produced by
 * {@link IdentityModule} and imported here so the controllers can
 * `@UseGuards(...)` them with DI satisfied (the auth guards need `JwtService`,
 * which `IdentityModule`'s `JwtModule.register` provides). `PrismaService` is
 * `@Global` so it is available without an explicit import.
 *
 * Decimal validation lives in the service layer via the pure helpers in
 * `decimal-validation.ts`; money/hours are carried as strings on the wire and
 * parsed with `Prisma.Decimal`.
 */
@Module({
  imports: [IdentityModule],
  controllers: [CatalogAdminController, CatalogMiniController],
  providers: [CatalogCommandService, CatalogQueryService],
})
export class CatalogModule {}
