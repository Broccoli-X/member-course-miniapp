import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import {
  type CommandContext,
  type HourPostingResult,
  type ManualDebitCommand,
  type ManualGrantCommand,
} from '@member-course/contracts';
import { AdminAuthGuard } from '../../../identity/presentation/admin/admin-auth.guard.js';
import { BusinessError } from '../../../../common/errors/business-error.js';
import { HourLedgerService } from '../../application/hour-ledger.service.js';
import {
  ManualDebitAdjustmentDto,
  ManualGrantAdjustmentDto,
} from './dto/hour-adjustment.dto.js';

/**
 * Administrator manual-hour-adjustment endpoints (Task 10).
 *
 * Path prefix `admin/v1/students/:studentId/courses/:courseId/hour-adjustments`
 * combines with the global `/api` prefix to produce the two routes:
 *
 *   - `POST /api/admin/v1/students/:studentId/courses/:courseId/hour-adjustments/grant`
 *   - `POST /api/admin/v1/students/:studentId/courses/:courseId/hour-adjustments/debit`
 *
 * Every route is guarded by {@link AdminAuthGuard}: a member token fails the
 * access-token check (wrong `kind`) and is rejected 401. Both routes are
 * idempotent — they read an `Idempotency-Key` request header (defaulting to a
 * per-request random key) so a retried/doubled submit executes the work once.
 */
@UseGuards(AdminAuthGuard)
@Controller('admin/v1/students/:studentId/courses/:courseId/hour-adjustments')
export class HourAdminController {
  constructor(private readonly ledger: HourLedgerService) {}

  // ── Grant ───────────────────────────────────────────────────────────────

  @Post('grant')
  @HttpCode(HttpStatus.OK)
  async grant(
    @Param('studentId') studentId: string,
    @Param('courseId') courseId: string,
    @Body() body: ManualGrantAdjustmentDto,
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<HourPostingResult> {
    const command: ManualGrantCommand = {
      studentId,
      courseId,
      units: body.units,
      startsOn: body.startsOn,
      expiresOn: body.expiresOn,
      reason: body.reason,
    };
    return this.ledger.grantManual(command, contextFrom(req, idempotencyKey, 'grant'));
  }

  // ── Debit ───────────────────────────────────────────────────────────────

  @Post('debit')
  @HttpCode(HttpStatus.OK)
  async debit(
    @Param('studentId') studentId: string,
    @Param('courseId') courseId: string,
    @Body() body: ManualDebitAdjustmentDto,
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<HourPostingResult> {
    const command: ManualDebitCommand = {
      studentId,
      courseId,
      units: body.units,
      reason: body.reason,
    };
    return this.ledger.debitManual(command, contextFrom(req, idempotencyKey, 'debit'));
  }
}

// ── Module-private helpers ─────────────────────────────────────────────────

/** Read the admin id from the principal set by AdminAuthGuard, or 401. */
function requireAdmin(req: Request): string {
  const principal = (req as unknown as { adminPrincipal?: { adminUserId: string } })
    .adminPrincipal;
  if (!principal) {
    throw BusinessError.unauthorized('Admin principal missing');
  }
  return principal.adminUserId;
}

/**
 * Build a {@link CommandContext} from the request. The idempotency key defaults
 * to a random per-request key when the header is absent (so a caller who omits
 * it gets normal non-dedup behavior — every call runs once). `requestId` is the
 * trace id (set by TraceIdMiddleware) for log correlation.
 */
function contextFrom(
  req: Request,
  idempotencyKey: string | undefined,
  intent: string,
): CommandContext {
  const adminId = requireAdmin(req);
  const traceId = (req as unknown as { traceId?: string }).traceId ?? randomUUID();
  const key =
    idempotencyKey && idempotencyKey.trim().length > 0
      ? idempotencyKey.trim()
      : `${intent}:${adminId}:${traceId}`;
  return {
    actorType: 'ADMIN',
    actorId: adminId,
    requestId: traceId,
    idempotencyKey: key,
  };
}
