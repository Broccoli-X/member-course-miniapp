import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { type CourseWithPackagesView } from '@member-course/contracts';
import { MiniAuthGuard } from '../../../identity/presentation/mini/mini-auth.guard.js';
import { BoundMemberGuard } from '../../../identity/presentation/mini/bound-member.guard.js';
import { CatalogQueryService } from '../../application/catalog-query.service.js';
import { validatePagination } from '../../../../common/http/pagination.dto.js';

/**
 * Mini-program (member) public catalog endpoints.
 *
 * Path prefix `mini/v1/courses` combines with the global `/api` prefix to
 * produce:
 *   - `GET /api/mini/v1/courses`
 *   - `GET /api/mini/v1/courses/:id`
 *
 * Both routes use {@link MiniAuthGuard} (verify the member access token) AND
 * {@link BoundMemberGuard} (reject provisional/unbound members) — per the
 * global constraint, WeChat login + verified phone binding is required before
 * any private-asset access, even for the otherwise-public catalog.
 *
 * Archived courses AND archived packages are hidden from these routes (only
 * ACTIVE rows are returned). An archived course id requested by detail yields
 * 404 RESOURCE_NOT_FOUND (not distinguishable from "missing").
 */
@UseGuards(MiniAuthGuard, BoundMemberGuard)
@Controller('mini/v1')
export class CatalogMiniController {
  constructor(private readonly query: CatalogQueryService) {}

  @Get('courses')
  @HttpCode(HttpStatus.OK)
  async listCourses(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<{
    items: CourseWithPackagesView[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const pagination = validatePagination({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
    return this.query.listPublic({
      page: pagination.page,
      pageSize: pagination.pageSize,
    });
  }

  @Get('courses/:id')
  @HttpCode(HttpStatus.OK)
  async courseDetail(@Param('id') id: string): Promise<CourseWithPackagesView> {
    return this.query.publicDetail(id);
  }
}
