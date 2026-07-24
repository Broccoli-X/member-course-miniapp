import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminAuthController } from './presentation/admin/admin-auth.controller.js';
import { AdminAuthGuard } from './presentation/admin/admin-auth.guard.js';
import { AdminAuthService } from './application/admin-auth.service.js';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher.js';
import { JwtTokenService } from './infrastructure/jwt-token.service.js';
import { WechatHttpGateway } from './infrastructure/wechat-http.gateway.js';
import { WechatAuthService } from './application/wechat-auth.service.js';
import { PhoneBindingService } from './application/phone-binding.service.js';
import { MiniAuthController } from './presentation/mini/mini-auth.controller.js';
import { MiniAuthGuard } from './presentation/mini/mini-auth.guard.js';
import { BoundMemberGuard } from './presentation/mini/bound-member.guard.js';
import { PASSWORD_HASHER, TOKEN_SERVICE, WECHAT_GATEWAY } from './tokens.js';

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
 * Binds the auth-service ports to the argon2 / JWT / WeChat adapters so the
 * whole feature can be imported with a single line in `AppModule`. The JWT
 * secret is resolved by {@link resolveJwtSecret}, which fails fast when unset
 * outside `test` (no insecure committed default).
 *
 * The {@link WECHAT_GATEWAY} port is bound to the real {@link WechatHttpGateway}
 * here. Tests override this DI token with a fake gateway (see
 * `test/doubles/fake-wechat.gateway.ts`) via
 * `Test.createTestingModule().overrideProvider(WECHAT_GATEWAY)`.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: resolveJwtSecret(),
      signOptions: { algorithm: 'HS256' },
    }),
  ],
  controllers: [AdminAuthController, MiniAuthController],
  providers: [
    AdminAuthService,
    AdminAuthGuard,
    WechatAuthService,
    PhoneBindingService,
    MiniAuthGuard,
    BoundMemberGuard,
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: TOKEN_SERVICE, useClass: JwtTokenService },
    { provide: WECHAT_GATEWAY, useClass: WechatHttpGateway },
  ],
  exports: [AdminAuthService, AdminAuthGuard, WechatAuthService, PhoneBindingService],
})
export class IdentityModule {}
