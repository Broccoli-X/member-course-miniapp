import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type CourseBalanceView,
  type CoursePackageView,
  type HourTransactionView,
  type PaginatedResult,
} from '@member-course/contracts';
import { AdminAuthGuard } from '../../../identity/presentation/admin/admin-auth.guard.js';
import { validatePagination } from '../../../../common/http/pagination.dto.js';
import { MemberAssetQueryService } from '../../application/member-asset-query.service.js';

/**
 * Administrator member-asset read endpoints (Task 11).
 *
 * Path prefix `admin/v1/students/:studentId` combines with the global `/api`
 * prefix to produce:
 *   - `GET /api/admin/v1/students/:studentId/course-balances`
 *   - `GET /api/admin/v1/students/:studentId/course-packages`
 *   - `GET /api/admin/v1/students/:studentId/hour-transactions`
 *
 * Every route is guarded by {@link AdminAuthGuard}. Unlike the mini
 * counterpart, the admin does NOT call `StudentAccessService.assertRelated` —
 * an admin may view ANY student's assets (support/audit use case), so there is
 * no relation gate. A member token is rejected with 401 by the guard.
 */
@UseGuards(AdminAuthGuard)
@Controller('admin/v1/students')
export class MemberAssetAdminController {
  constructor(private readonly assets: MemberAssetQueryService) {}

  @Get(':studentId/course-balances')
  @HttpCode(HttpStatus.OK)
  async listBalances(
    @Param('studentId') studentId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<PaginatedResult<CourseBalanceView>> {
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
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<PaginatedResult<CoursePackageView>> {
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
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sort') sort?: string,
  ): Promise<PaginatedResult<HourTransactionView>> {
    const pagination = validatePagination({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      sort,
    });
    return this.assets.listTransactions(studentId, pagination);
  }
}
