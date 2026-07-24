import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminAuthController } from './presentation/admin/admin-auth.controller.js';
import { AdminAuthGuard } from './presentation/admin/admin-auth.guard.js';
import { AdminAuthService } from './application/admin-auth.service.js';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher.js';
import { JwtTokenService } from './infrastructure/jwt-token.service.js';
import { PASSWORD_HASHER, TOKEN_SERVICE } from './tokens.js';

/**
 * Resolve the JWT signing secret at module load.
 *
 * Fail-fast mirrors the seed-credential policy (brief: ADMIN_SEED_*
 * absent → throw): a missing `JWT_SECRET` silently falling back to a
 * committed value would let anyone forge admin access tokens in
 * production. Outside `test`, an unset/empty secret throws. In `test`,
 * an unset secret falls back to a known value so test bootstraps that do
 * not set the var (e.g. unit tests that happen to import this module)
 * keep working.
 */
const TEST_JWT_SECRET_FALLBACK = 'test-jwt-secret-fallback';
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.trim().length > 0) {
    return secret;
  }
  if (process.env.NODE_ENV === 'test') {
    return TEST_JWT_SECRET_FALLBACK;
  }
  throw new Error('JWT_SECRET must be set');
}

/**
 * Identity feature module.
 *
 * Binds the auth-service ports to the argon2 / JWT adapters so the whole
 * feature can be imported with a single line in `AppModule`. The JWT secret
 * is resolved by {@link resolveJwtSecret}, which fails fast when unset
 * outside `test` (no insecure committed default).
 */
@Module({
  imports: [
    JwtModule.register({
      secret: resolveJwtSecret(),
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
