import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminPrincipal, AdminAccessTokenPayload } from '@member-course/contracts';
import { BusinessError } from '../../../../common/errors/business-error.js';

/**
 * Extracts a Bearer access token from the `Authorization` header, verifies it
 * via {@link JwtService}, and produces an {@link AdminPrincipal} on the request
 * for downstream handlers. Throw a `BusinessError` (401) when the header is
 * absent, malformed, expired, or has the wrong `kind`.
 *
 * Usage: apply per-controller (`@UseGuards(AdminAuthGuard)`) — not globally —
 * so public endpoints (login/refresh/logout) are unaffected.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  // Re-exported as a static symbol so consumers can `@UseGuards(AdminAuthGuard)`
  // and DI it via the same class reference.
  static readonly REQUEST_PRINCIPAL_KEY = 'adminPrincipal';

  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      adminPrincipal?: AdminPrincipal;
    }>();

    const header = request.headers['authorization'];
    const token = this.extractBearer(header);
    if (!token) {
      throw BusinessError.unauthorized('Missing or malformed Authorization header');
    }

    let payload: AdminAccessTokenPayload;
    try {
      payload = (await this.jwt.verifyAsync<AdminAccessTokenPayload>(token)) as AdminAccessTokenPayload;
    } catch {
      throw BusinessError.unauthorized('Invalid or expired access token');
    }

    if (payload.kind !== 'access' || typeof payload.sub !== 'string') {
      throw BusinessError.unauthorized('Invalid access token');
    }

    request.adminPrincipal = {
      adminUserId: payload.sub,
      username: payload.username,
    };
    return true;
  }

  private extractBearer(
    header: string | string[] | undefined,
  ): string | null {
    if (!header || Array.isArray(header)) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : null;
  }
}
