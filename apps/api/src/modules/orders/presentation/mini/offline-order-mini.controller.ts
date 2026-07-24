import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  type MiniOrderView,
  type MemberPrincipal,
  type PaginatedResult,
} from '@member-course/contracts';
import { MiniAuthGuard } from '../../../identity/presentation/mini/mini-auth.guard.js';
import { BoundMemberGuard } from '../../../identity/presentation/mini/bound-member.guard.js';
import { validatePagination } from '../../../../common/http/pagination.dto.js';
import { OfflineOrderQueryService } from '../../application/offline-order-query.service.js';

/**
 * Mini-program (member) offline-order read endpoints (Task 11).
 *
 * Path prefix `mini/v1/orders` combines with the global `/api` prefix to
 * produce:
 *   - `GET /api/mini/v1/orders`
 *   - `GET /api/mini/v1/orders/:id`
 *
 * Both routes are guarded by {@link MiniAuthGuard} + {@link BoundMemberGuard}
 * and scoped to the member's OWN `accountId` as `buyerAccountId` (buyer
 * isolation). The member never sees another buyer's orders.
 */
@UseGuards(MiniAuthGuard, BoundMemberGuard)
@Controller('mini/v1/orders')
export class OfflineOrderMiniController {
  constructor(private readonly query: OfflineOrderQueryService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<PaginatedResult<MiniOrderView>> {
    const pagination = validatePagination({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
    return this.query.listForBuyer(req.memberPrincipal!.accountId, pagination);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('id') id: string,
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
  ): Promise<MiniOrderView> {
    return this.query.detailForBuyer(id, req.memberPrincipal!.accountId);
  }
}
