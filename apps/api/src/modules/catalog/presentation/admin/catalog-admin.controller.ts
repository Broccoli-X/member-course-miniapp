import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type CourseView,
  type CourseWithPackagesView,
  type PackageProductView,
} from '@member-course/contracts';
import { AdminAuthGuard } from '../../../identity/presentation/admin/admin-auth.guard.js';
import { CatalogCommandService } from '../../application/catalog-command.service.js';
import { CatalogQueryService } from '../../application/catalog-query.service.js';
import { validatePagination } from '../../../../common/http/pagination.dto.js';
import {
  CreateCourseDto,
  CreatePackageProductDto,
  UpdateCourseDto,
  UpdatePackageProductDto,
} from './dto/catalog.dto.js';

/**
 * Administrator catalog endpoints.
 *
 * Path prefixes `admin/v1/courses` and `admin/v1/package-products` combine with
 * the global `/api` prefix to produce:
 *   - `GET    /api/admin/v1/courses`
 *   - `POST   /api/admin/v1/courses`
 *   - `PATCH  /api/admin/v1/courses/:id`
 *   - `POST   /api/admin/v1/courses/:id/archive`
 *   - `POST   /api/admin/v1/courses/:courseId/package-products`
 *   - `PATCH  /api/admin/v1/package-products/:id`
 *   - `POST   /api/admin/v1/package-products/:id/archive`
 *
 * Every route is guarded by {@link AdminAuthGuard}: a mini-program member token
 * fails the admin-token check (wrong `kind`) and is rejected with 401.
 *
 * Referenced records are archived, never physically deleted.
 */
@UseGuards(AdminAuthGuard)
@Controller('admin/v1')
export class CatalogAdminController {
  constructor(
    private readonly command: CatalogCommandService,
    private readonly query: CatalogQueryService,
  ) {}

  // ── Courses ───────────────────────────────────────────────────────────

  @Get('courses')
  @HttpCode(HttpStatus.OK)
  async listCourses(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
  ): Promise<{ items: CourseView[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const pagination = validatePagination({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
    return this.query.list({
      page: pagination.page,
      pageSize: pagination.pageSize,
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    });
  }

  @Post('courses')
  @HttpCode(HttpStatus.CREATED)
  async createCourse(@Body() body: CreateCourseDto): Promise<CourseView> {
    return this.command.createCourse({
      name: body.name,
      type: body.type,
      description: body.description,
    });
  }

  @Patch('courses/:id')
  @HttpCode(HttpStatus.OK)
  async updateCourse(
    @Param('id') id: string,
    @Body() body: UpdateCourseDto,
  ): Promise<CourseView> {
    return this.command.updateCourse(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
  }

  @Post('courses/:id/archive')
  @HttpCode(HttpStatus.OK)
  async archiveCourse(@Param('id') id: string): Promise<CourseView> {
    return this.command.archiveCourse(id);
  }

  // ── Package products ──────────────────────────────────────────────────

  @Post('courses/:courseId/package-products')
  @HttpCode(HttpStatus.CREATED)
  async createPackageProduct(
    @Param('courseId') courseId: string,
    @Body() body: CreatePackageProductDto,
  ): Promise<PackageProductView> {
    return this.command.createPackageProduct(courseId, {
      name: body.name,
      price: body.price,
      hours: body.hours,
      validDays: body.validDays,
    });
  }

  @Patch('package-products/:id')
  @HttpCode(HttpStatus.OK)
  async updatePackageProduct(
    @Param('id') id: string,
    @Body() body: UpdatePackageProductDto,
  ): Promise<PackageProductView> {
    return this.command.updatePackageProduct(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.price !== undefined ? { price: body.price } : {}),
      ...(body.hours !== undefined ? { hours: body.hours } : {}),
      ...(body.validDays !== undefined ? { validDays: body.validDays } : {}),
    });
  }

  @Post('package-products/:id/archive')
  @HttpCode(HttpStatus.OK)
  async archivePackageProduct(@Param('id') id: string): Promise<PackageProductView> {
    return this.command.archivePackageProduct(id);
  }
}

// Re-export so the module's public surface is self-documenting. (Type only;
// the mini course-with-packages shape is also produced by the query service.)
export type { CourseWithPackagesView };
