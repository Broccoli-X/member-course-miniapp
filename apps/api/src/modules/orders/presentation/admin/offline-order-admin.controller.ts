import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import {
  type CommandContext,
  type CreateOfflineOrderCommand,
  type OfflineOrderDto,
  type PaginatedResult,
} from '@member-course/contracts';
import { AdminAuthGuard } from '../../../identity/presentation/admin/admin-auth.guard.js';
import { OfflineOrderService } from '../../application/offline-order.service.js';
import { OfflineOrderQueryService } from '../../application/offline-order-query.service.js';
import { validatePagination } from '../../../../common/http/pagination.dto.js';
import { BusinessError } from '../../../../common/errors/business-error.js';
import {
  CreateOfflineOrderDto,
  ReverseOfflineOrderDto,
} from './dto/offline-order.dto.js';

/**
 * Administrator offline-order endpoints (Task 9).
 *
 * Path prefix `admin/v1/orders` combines with the global `/api` prefix to
 * produce the six routes:
 *   - `GET    /api/admin/v1/orders`
 *   - `POST   /api/admin/v1/orders`
 *   - `GET    /api/admin/v1/orders/:id`
 *   - `POST   /api/admin/v1/orders/:id/confirm`
 *   - `POST   /api/admin/v1/orders/:id/void`
 *   - `POST   /api/admin/v1/orders/:id/reverse`
 *
 * Every route is guarded by {@link AdminAuthGuard}: a member token fails the
 * access-token check (wrong `kind`) and is rejected 401.
 *
 * confirm/void/reverse are idempotent — they read an `Idempotency-Key` request
 * header (defaulting to a per-request random key) so a retried/doubled submit
 * executes the work exactly once.
 */
@UseGuards(AdminAuthGuard)
@Controller('admin/v1/orders')
export class OfflineOrderAdminController {
  constructor(
    private readonly command: OfflineOrderService,
    private readonly query: OfflineOrderQueryService,
  ) {}

  // ── List ────────────────────────────────────────────────────────────────

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('buyerAccountId') buyerAccountId?: string,
  ): Promise<PaginatedResult<OfflineOrderDto>> {
    const pagination = validatePagination({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
    return this.query.list({
      page: pagination.page,
      pageSize: pagination.pageSize,
      ...(status ? { status } : {}),
      ...(buyerAccountId ? { buyerAccountId } : {}),
    });
  }

  // ── Create draft ────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDraft(
    @Body() body: CreateOfflineOrderDto,
    @Req() req: Request,
  ): Promise<OfflineOrderDto> {
    const adminId = requireAdmin(req);
    const command: CreateOfflineOrderCommand = {
      buyerAccountId: body.buyerAccountId,
      items: Array.isArray(body.items)
        ? body.items.map((it) => ({ studentId: it.studentId, productId: it.productId }))
        : [],
    };
    return this.command.createDraft(command, adminId);
  }

  // ── Detail ──────────────────────────────────────────────────────────────

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async detail(@Param('id') id: string): Promise<OfflineOrderDto> {
    return this.query.detail(id);
  }

  // ── Confirm ─────────────────────────────────────────────────────────────

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Param('id') id: string,
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OfflineOrderDto> {
    return this.command.confirm(id, contextFrom(req, idempotencyKey, 'confirm'));
  }

  // ── Void ────────────────────────────────────────────────────────────────

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  async void(
    @Param('id') id: string,
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ voided: true }> {
    await this.command.voidDraft(id, contextFrom(req, idempotencyKey, 'void'));
    return { voided: true };
  }

  // ── Reverse ─────────────────────────────────────────────────────────────

  @Post(':id/reverse')
  @HttpCode(HttpStatus.OK)
  async reverse(
    @Param('id') id: string,
    @Body() body: ReverseOfflineOrderDto,
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OfflineOrderDto> {
    return this.command.reverse(
      id,
      { ...(body.reason !== undefined ? { reason: body.reason } : {}) },
      contextFrom(req, idempotencyKey, 'reverse'),
    );
  }
}

// ── Module-private helpers ─────────────────────────────────────────────────

/** Read the admin id from the principal set by AdminAuthGuard, or 401. */
function requireAdmin(req: Request): string {
  const principal = (req as unknown as { adminPrincipal?: { adminUserId: string } }).adminPrincipal;
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
