/**
 * NestJS DI tokens for the abstract identity ports. Because TypeScript
 * interfaces are erased at runtime, {@link AdminAuthService} cannot rely on
 * parameter-type reflection alone — these symbols let the DI container resolve
 * the {@link PasswordHasher}/{@link TokenService} ports to the concrete
 * adapters registered in {@link IdentityModule}.
 *
 * Tests bypass DI entirely by constructing the service with `new`, so these
 * tokens are only ever referenced from the module wiring and the service's
 * `@Inject(...)` decorators.
 */
import type { PasswordHasher, TokenService } from './domain/password-hasher.js';

export const PASSWORD_HASHER: unique symbol = Symbol('PASSWORD_HASHER');
export const TOKEN_SERVICE: unique symbol = Symbol('TOKEN_SERVICE');

/** Type helpers so DI registration stays in sync with the port interfaces. */
export type { PasswordHasher, TokenService };
