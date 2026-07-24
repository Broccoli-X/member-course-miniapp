export interface ApiEnvelope<T = unknown> {
  code: string;
  message: string;
  traceId: string;
  data?: T;
  details?: Record<string, unknown>;
}

/**
 * Context carried by every mutating command (the M1 plan preamble defines this
 * shape). It identifies WHO is acting (`actorType`/`actorId`), WHICH request
 * this is (`requestId`, for trace correlation), and provides the
 * `idempotencyKey` that the {@link IdempotencyService} uses to deduplicate
 * concurrent/retried identical requests (e.g. two confirm clicks landing at
 * once — only one runs the work).
 *
 * `actorType` discriminates admin vs member vs system-initiated work; downstream
 * code can scope authorization or audit off it. The Orders module is admin-only
 * in M1, so its commands always carry `actorType: 'ADMIN'`.
 */
export interface CommandContext {
  readonly actorType: 'ADMIN' | 'MEMBER' | 'SYSTEM';
  readonly actorId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}
