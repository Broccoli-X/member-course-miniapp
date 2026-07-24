import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminAuthController } from './presentation/admin/admin-auth.controller.js';
import { AdminAuthGuard } from './presentation/admin/admin-auth.guard.js';
import { AdminAuthService } from './application/admin-auth.service.js';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher.js';
import { JwtTokenService } from './infrastructure/jwt-token.service.js';
import { PASSWORD_HASHER, TOKEN_SERVICE } from './tokens.js';

/**
 * Identity feature module.
 *
 * Binds the auth-service ports to the argon2 / JWT adapters so the whole
 * feature can be imported with a single line in `AppModule`. The JWT secret is
 * read from `JWT_SECRET` at module load; an explicit dev-only fallback keeps
 * the app bootable in unit tests that override the provider.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
      signOptions: { algorithm: 'HS256' },
    }),
  ],
  controllers: [AdminAuthController],
  providers: [
    AdminAuthService,
    AdminAuthGuard,
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: TOKEN_SERVICE, useClass: JwtTokenService },
  ],
  exports: [AdminAuthService, AdminAuthGuard],
})
export class IdentityModule {}
