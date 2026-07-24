import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import {
  ERROR_CODES,
  HTTP_STATUS,
  type MemberPrincipal,
} from '@member-course/contracts';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../../common/errors/business-error.js';
import { MEMBER_STATUS } from '../../application/wechat-auth.service.js';

/**
 * Rejects provisional / unbound / suspended member accounts from private
 * (member-only) endpoints with HTTP 403 `STUDENT_FORBIDDEN`.
 *
 * This is distinct from {@link MiniAuthGuard}: that guard only verifies the
 * access token and produces a {@link MemberPrincipal}. This guard additionally
 * reloads the live `MemberAccount` row and asserts the member is ACTIVE and
 * NOT provisional — so a token minted before phone binding (which carries
 * `provisional: true` but is still a valid signature) cannot reach private
 * routes, AND a member who bound their phone but whose old token still claims
 * `provisional: true` is admitted because the DB row is the source of truth.
 *
 * Usage (NOT wired into any route yet — provided for the upcoming private
 * catalog/student endpoints per task-5-brief):
 *
 * ```ts
 * @UseGuards(MiniAuthGuard, BoundMemberGuard)
 * @Controller('mini/v1/...')
 * ```
 *
 * The {@link MiniAuthGuard} must run first to populate `request.memberPrincipal`.
 */
@Injectable()
export class BoundMemberGuard implements CanActivate {
  constructor(private readonly db: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      memberPrincipal?: MemberPrincipal;
    }>();
    const principal = request.memberPrincipal;
    if (!principal) {
      // No mini principal → MiniAuthGuard didn't run, or did and failed.
      // Treat as forbidden rather than unauthorized so the error is distinct
      // from a missing/invalid token.
      throw new BusinessError(
        ERROR_CODES.STUDENT_FORBIDDEN,
        'Member principal is required',
        HTTP_STATUS.FORBIDDEN,
      );
    }

    const account = await this.db.memberAccount.findUnique({
      where: { id: principal.accountId },
      select: { status: true, isProvisional: true },
    });
    if (!account || account.status !== MEMBER_STATUS.ACTIVE || account.isProvisional) {
      // Provisional accounts may reach ONLY the public catalog + the 4 auth
      // endpoints. Every other route is gated here.
      throw new BusinessError(
        ERROR_CODES.STUDENT_FORBIDDEN,
        'Phone number must be bound before accessing this resource',
        HTTP_STATUS.FORBIDDEN,
      );
    }
    return true;
  }
}
