/**
 * NestJS DI tokens for the abstract identity ports. Because TypeScript
 * interfaces are erased at runtime, {@link AdminAuthService} cannot rely on
 * parameter-type reflection alone — these symbols let the DI container resolve
 * the {@link PasswordHasher}/{@link TokenService}/{@link WechatGateway} ports
 * to the concrete adapters registered in {@link IdentityModule}.
 *
 * Tests bypass DI entirely by constructing the service with `new`, so these
 * tokens are only ever referenced from the module wiring and the service's
 * `@Inject(...)` decorators.
 */
import type { PasswordHasher, TokenService } from './domain/password-hasher.js';
import type { WechatGateway } from './domain/wechat-gateway.js';

export const PASSWORD_HASHER: unique symbol = Symbol('PASSWORD_HASHER');
export const TOKEN_SERVICE: unique symbol = Symbol('TOKEN_SERVICE');
/** DI token for the {@link WechatGateway} port (real HTTP in prod, fake in tests). */
export const WECHAT_GATEWAY: unique symbol = Symbol('WECHAT_GATEWAY');

/** Type helpers so DI registration stays in sync with the port interfaces. */
export type { PasswordHasher, TokenService };
export type { WechatGateway };
