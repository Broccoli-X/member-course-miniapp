import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  type MemberAccessTokenPayload,
  type MemberPrincipal,
} from '@member-course/contracts';
import { BusinessError } from '../../../../common/errors/business-error.js';

/**
 * Extracts a Bearer member access token from the `Authorization` header,
 * verifies it via {@link JwtService}, and produces a {@link MemberPrincipal}
 * on the request for downstream handlers. Throws a `BusinessError` (401) when
 * the header is absent, malformed, expired, or has the wrong `kind`.
 *
 * The principal's `provisional` flag is taken from the JWT payload — it is
 * advisory only. {@link BoundMemberGuard} reloads `isProvisional` from the
 * live `MemberAccount` row before allowing access to private endpoints, so a
 * token minted before phone binding cannot be used to bypass the bound-only
 * check after binding.
 *
 * Usage: apply per-controller (`@UseGuards(MiniAuthGuard)`) — not globally —
 * so public endpoints (wechat-login/refresh/logout) are unaffected. The
 * `bind-phone` endpoint DOES use this guard: only an authenticated mini
 * principal can bind a phone, but the principal may still be provisional.
 */
@Injectable()
export class MiniAuthGuard implements CanActivate {
  /** Key under which the {@link MemberPrincipal} is attached to the request. */
  static readonly REQUEST_PRINCIPAL_KEY = 'memberPrincipal';

  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      memberPrincipal?: MemberPrincipal;
    }>();

    const header = request.headers['authorization'];
    const token = this.extractBearer(header);
    if (!token) {
      throw BusinessError.unauthorized('Missing or malformed Authorization header');
    }

    let payload: MemberAccessTokenPayload;
    try {
      payload = (await this.jwt.verifyAsync<MemberAccessTokenPayload>(token)) as MemberAccessTokenPayload;
    } catch {
      throw BusinessError.unauthorized('Invalid or expired access token');
    }

    if (payload.kind !== 'member' || typeof payload.sub !== 'string') {
      throw BusinessError.unauthorized('Invalid member access token');
    }

    request.memberPrincipal = {
      accountId: payload.sub,
      provisional: Boolean(payload.provisional),
    };
    return true;
  }

  private extractBearer(header: string | string[] | undefined): string | null {
    if (!header || Array.isArray(header)) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : null;
  }
}
