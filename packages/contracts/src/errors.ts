export type ErrorDetails = Record<string, unknown>;

export interface BusinessErrorShape {
  code: string;
  message: string;
  httpStatus: number;
  traceId?: string;
  details?: ErrorDetails;
}

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  STATE_CHANGED: 'STATE_CHANGED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  STUDENT_FORBIDDEN: 'STUDENT_FORBIDDEN',
  ADMIN_LOGIN_LOCKED: 'ADMIN_LOGIN_LOCKED',
  /**
   * Raised when a mini-program phone-binding transaction detects that the
   * pre-created member account that owns the verified phone already owns a
   * *different* WeChat identity. Mapped to HTTP 409 CONFLICT, but kept distinct
   * from {@link STATE_CHANGED} so callers can surface a specific message.
   */
  PHONE_BINDING_CONFLICT: 'PHONE_BINDING_CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
} as const;
