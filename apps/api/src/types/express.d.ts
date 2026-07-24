import type { AdminPrincipal } from '@member-course/contracts';

declare module 'express-serve-static-core' {
  interface Request {
    traceId?: string;
    /** Set by AdminAuthGuard after verifying an admin access token. */
    adminPrincipal?: AdminPrincipal;
  }
}
