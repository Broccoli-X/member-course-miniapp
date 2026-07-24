import { Injectable } from '@nestjs/common';
import {
  CATALOG_STATUS,
  type CourseView,
  type CourseWithPackagesView,
  type PackageProductView,
  type PaginatedResult,
  type PaginationParams,
} from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import { toDecimalString } from './decimal-validation.js';

/** Convert a Prisma Course row to the wire {@link CourseView}. */
export function toCourseView(row: {
  id: string;
  name: string;
  type: string;
  description: string;
  status: string;
  version: number;
}): CourseView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    status: row.status,
    version: row.version,
  };
}

/** Convert a Prisma PackageProduct row to the wire {@link PackageProductView}. */
export function toPackageView(row: {
  id: string;
  courseId: string;
  name: string;
  price: { toString(): string } | string;
  hours: { toString(): string } | string;
  validDays: number;
  status: string;
  version: number;
}): PackageProductView {
  return {
    id: row.id,
    courseId: row.courseId,
    name: row.name,
    price: toDecimalString(row.price as never) ?? '0.00',
    hours: toDecimalString(row.hours as never) ?? '0.00',
    validDays: row.validDays,
    status: row.status,
    version: row.version,
  };
}

/**
 * Admin catalog read-side queries.
 *
 * Admin sees ALL courses (ACTIVE and ARCHIVED); the mini-program read path
 * lives in the same service but is scoped to ACTIVE only via the dedicated
 * {@link listPublic}/{@link publicDetail} methods.
 */
@Injectable()
export class CatalogQueryService {
  constructor(private readonly db: PrismaService) {}

  /**
   * Paginated admin course list. Optionally filtered by `status`
   * (ACTIVE|ARCHIVED) and/or `type` (CLASS|ONE_TO_ONE). Ordered by newest first
   * for back-office ergonomics.
   */
  async list(
    params: PaginationParams & { status?: string; type?: string },
  ): Promise<PaginatedResult<CourseView>> {
    const where: { status?: string; type?: string } = {};
    if (params.status) where.status = params.status;
    if (params.type) where.type = params.type;

    const [total, rows] = await Promise.all([
      this.db.course.count({ where }),
      this.db.course.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    return {
      items: rows.map(toCourseView),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages,
    };
  }

  /**
   * Public (mini) course list: ACTIVE courses only, each with their ACTIVE
   * packages attached. Archived courses AND archived packages are hidden from
   * the mini program (task-7-brief.md: "hides archived catalog records").
   */
  async listPublic(
    params: PaginationParams,
  ): Promise<PaginatedResult<CourseWithPackagesView>> {
    const where = { status: CATALOG_STATUS.ACTIVE };
    const [total, rows] = await Promise.all([
      this.db.course.count({ where }),
      this.db.course.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          packages: {
            where: { status: CATALOG_STATUS.ACTIVE },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    return {
      items: rows.map((c) => ({
        course: toCourseView(c),
        packages: c.packages.map(toPackageView),
      })),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages,
    };
  }

  /**
   * Public course detail: returns the course only if ACTIVE, with its ACTIVE
   * packages. Throws `RESOURCE_NOT_FOUND` (404) if the course is missing OR
   * archived — the mini program must not distinguish the two cases (an archived
   * record is, from the member's perspective, gone).
   */
  async publicDetail(courseId: string): Promise<CourseWithPackagesView> {
    const course = await this.db.course.findUnique({
      where: { id: courseId },
      include: {
        packages: {
          where: { status: CATALOG_STATUS.ACTIVE },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!course || course.status !== CATALOG_STATUS.ACTIVE) {
      throw BusinessError.notFound('Course not found', { courseId });
    }
    return {
      course: toCourseView(course),
      packages: course.packages.map(toPackageView),
    };
  }
}
