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
  type CourseBalanceView,
  type CoursePackageView,
  type HourTransactionView,
  type MemberPrincipal,
  type PaginatedResult,
} from '@member-course/contracts';
import { MiniAuthGuard } from '../../../identity/presentation/mini/mini-auth.guard.js';
import { BoundMemberGuard } from '../../../identity/presentation/mini/bound-member.guard.js';
import { StudentAccessService } from '../../../identity/application/student-access.service.js';
import { validatePagination } from '../../../../common/http/pagination.dto.js';
import { MemberAssetQueryService } from '../../application/member-asset-query.service.js';

/**
 * Mini-program member asset read endpoints (Task 11).
 *
 * Path prefix `mini/v1/students/:studentId` combines with the global `/api`
 * prefix to produce the three read routes:
 *   - `GET /api/mini/v1/students/:studentId/course-balances`
 *   - `GET /api/mini/v1/students/:studentId/course-packages`
 *   - `GET /api/mini/v1/students/:studentId/hour-transactions`
 *
 * Every route is guarded by {@link MiniAuthGuard} (verify the member token) AND
 * {@link BoundMemberGuard} (reject provisional/unbound members), then
 * authorizes the student relation via {@link StudentAccessService.assertRelated}
 * BEFORE reading any data. An unrelated student → 403 `STUDENT_FORBIDDEN`.
 */
@UseGuards(MiniAuthGuard, BoundMemberGuard)
@Controller('mini/v1/students')
export class MemberAssetMiniController {
  constructor(
    private readonly assets: MemberAssetQueryService,
    private readonly access: StudentAccessService,
  ) {}

  @Get(':studentId/course-balances')
  @HttpCode(HttpStatus.OK)
  async listBalances(
    @Param('studentId') studentId: string,
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<PaginatedResult<CourseBalanceView>> {
    await this.access.assertRelated(req.memberPrincipal!.accountId, studentId);
    const pagination = validatePagination({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
    return this.assets.listBalances(studentId, pagination);
  }

  @Get(':studentId/course-packages')
  @HttpCode(HttpStatus.OK)
  async listPackages(
    @Param('studentId') studentId: string,
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<PaginatedResult<CoursePackageView>> {
    await this.access.assertRelated(req.memberPrincipal!.accountId, studentId);
    const pagination = validatePagination({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
    return this.assets.listPackages(studentId, pagination);
  }

  @Get(':studentId/hour-transactions')
  @HttpCode(HttpStatus.OK)
  async listTransactions(
    @Param('studentId') studentId: string,
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sort') sort?: string,
  ): Promise<PaginatedResult<HourTransactionView>> {
    await this.access.assertRelated(req.memberPrincipal!.accountId, studentId);
    const pagination = validatePagination({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      sort,
    });
    return this.assets.listTransactions(studentId, pagination);
  }
}
