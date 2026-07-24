import { Injectable } from '@nestjs/common';
import {
  CATALOG_STATUS,
  COURSE_TYPE,
  type CourseView,
  type CreateCourseRequest,
  type CreatePackageProductRequest,
  type PackageProductView,
  type UpdateCourseRequest,
  type UpdatePackageProductRequest,
} from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import {
  assertDecimalScale,
  assertPositiveHours,
  assertPositiveValidDays,
} from './decimal-validation.js';
import { toCourseView, toPackageView } from './catalog-query.service.js';

/** Allowed course types for M1 (CLASS | ONE_TO_ONE). */
const VALID_COURSE_TYPES: ReadonlySet<string> = new Set<string>([
  COURSE_TYPE.CLASS,
  COURSE_TYPE.ONE_TO_ONE,
]);

/** Maximum length of `Course.name` (matches VarChar(100)). */
const COURSE_NAME_MAX_LENGTH = 100;
/** Maximum length of `PackageProduct.name` (matches VarChar(100)). */
const PACKAGE_NAME_MAX_LENGTH = 100;

/**
 * Admin catalog write-side operations.
 *
 * Creates/updates/archives courses and package products. Referenced records are
 * ARCHIVED, never physically deleted — orders/order-items reference them via
 * `onDelete: Restrict`, so a hard delete would either fail or orphan history.
 * The archive endpoints flip `status` ACTIVE→ARCHIVED and are idempotent.
 *
 * Decimal fields (`price`, `hours`) are validated at this layer using the pure
 * {@link assertDecimalScale} / {@link assertPositiveHours} helpers (see
 * decimal-validation.ts). Validation failures raise `BusinessError` which the
 * global filter maps to the documented HTTP status + code.
 */
@Injectable()
export class CatalogCommandService {
  constructor(private readonly db: PrismaService) {}

  // ── Courses ───────────────────────────────────────────────────────────

  /** Create a new ACTIVE course. Validates name + type. */
  async createCourse(args: CreateCourseRequest): Promise<CourseView> {
    assertCourseName(args.name);
    assertCourseType(args.type);
    assertDescription(args.description);

    const course = await this.db.course.create({
      data: {
        name: args.name,
        type: args.type,
        description: args.description,
        status: CATALOG_STATUS.ACTIVE,
      },
    });
    return toCourseView(course);
  }

  /** Patch a course's mutable fields. */
  async updateCourse(courseId: string, args: UpdateCourseRequest): Promise<CourseView> {
    const row = await this.db.course.findUnique({ where: { id: courseId } });
    if (!row) {
      throw BusinessError.notFound('Course not found', { courseId });
    }
    const data: { name?: string; type?: string; description?: string } = {};
    if (args.name !== undefined) {
      assertCourseName(args.name);
      data.name = args.name;
    }
    if (args.type !== undefined) {
      assertCourseType(args.type);
      data.type = args.type;
    }
    if (args.description !== undefined) {
      assertDescription(args.description);
      data.description = args.description;
    }

    if (Object.keys(data).length === 0) {
      return toCourseView(row);
    }
    const updated = await this.db.course.update({ where: { id: courseId }, data });
    return toCourseView(updated);
  }

  /**
   * Soft-archive a course (status ACTIVE→ARCHIVED). Idempotent: archiving an
   * already-archived course returns the same ARCHIVED view without error.
   * Never physically deletes — order items reference courses via Restrict.
   */
  async archiveCourse(courseId: string): Promise<CourseView> {
    const row = await this.db.course.findUnique({ where: { id: courseId } });
    if (!row) {
      throw BusinessError.notFound('Course not found', { courseId });
    }
    if (row.status === CATALOG_STATUS.ARCHIVED) {
      return toCourseView(row);
    }
    const updated = await this.db.course.update({
      where: { id: courseId },
      data: { status: CATALOG_STATUS.ARCHIVED },
    });
    return toCourseView(updated);
  }

  // ── Package products ──────────────────────────────────────────────────

  /**
   * Create a package product under a course. Validates the course exists and
   * is ACTIVE (an admin should not attach new sellable packages to an archived
   * course), then runs the decimal validation matrix:
   *  - `price`: decimal string, ≤2 dp → else `DECIMAL_SCALE_INVALID` (422).
   *  - `hours`: decimal string, ≤2 dp, >0 → else `HOURS_MUST_BE_POSITIVE` (422)
   *    for non-positive, `DECIMAL_SCALE_INVALID` (422) for >2 dp.
   *  - `validDays`: positive integer → else `VALID_DAYS_INVALID` (422).
   */
  async createPackageProduct(
    courseId: string,
    args: CreatePackageProductRequest,
  ): Promise<PackageProductView> {
    const course = await this.db.course.findUnique({ where: { id: courseId } });
    if (!course) {
      throw BusinessError.notFound('Course not found', { courseId });
    }
    if (course.status !== CATALOG_STATUS.ACTIVE) {
      // An archived course is not a valid host for a NEW sellable package.
      throw BusinessError.conflict('Cannot add packages to an archived course', {
        courseId,
        status: course.status,
      });
    }

    assertPackageName(args.name);
    const price = assertDecimalScale(args.price, 'price');
    const hours = assertPositiveHours(args.hours);
    const validDays = assertPositiveValidDays(args.validDays);

    const created = await this.db.packageProduct.create({
      data: {
        courseId,
        name: args.name,
        price: price.value,
        hours: hours.value,
        validDays,
        status: CATALOG_STATUS.ACTIVE,
      },
    });
    return toPackageView(created);
  }

  /** Patch a package product's mutable fields. Re-runs decimal validation. */
  async updatePackageProduct(
    packageId: string,
    args: UpdatePackageProductRequest,
  ): Promise<PackageProductView> {
    const row = await this.db.packageProduct.findUnique({
      where: { id: packageId },
    });
    if (!row) {
      throw BusinessError.notFound('Package product not found', { packageId });
    }
    const data: {
      name?: string;
      price?: ReturnType<typeof assertDecimalScale>['value'];
      hours?: ReturnType<typeof assertPositiveHours>['value'];
      validDays?: number;
    } = {};
    if (args.name !== undefined) {
      assertPackageName(args.name);
      data.name = args.name;
    }
    if (args.price !== undefined) {
      data.price = assertDecimalScale(args.price, 'price').value;
    }
    if (args.hours !== undefined) {
      data.hours = assertPositiveHours(args.hours).value;
    }
    if (args.validDays !== undefined) {
      data.validDays = assertPositiveValidDays(args.validDays);
    }

    if (Object.keys(data).length === 0) {
      return toPackageView(row);
    }
    const updated = await this.db.packageProduct.update({
      where: { id: packageId },
      data,
    });
    return toPackageView(updated);
  }

  /**
   * Soft-archive a package product. Idempotent. Never physically deletes —
   * order items reference packages via `onDelete: Restrict`.
   */
  async archivePackageProduct(packageId: string): Promise<PackageProductView> {
    const row = await this.db.packageProduct.findUnique({
      where: { id: packageId },
    });
    if (!row) {
      throw BusinessError.notFound('Package product not found', { packageId });
    }
    if (row.status === CATALOG_STATUS.ARCHIVED) {
      return toPackageView(row);
    }
    const updated = await this.db.packageProduct.update({
      where: { id: packageId },
      data: { status: CATALOG_STATUS.ARCHIVED },
    });
    return toPackageView(updated);
  }
}

// ── Field validators (module-private) ───────────────────────────────────

function assertCourseName(name: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw BusinessError.validationFailed('name is required', { field: 'name' });
  }
  if (name.length > COURSE_NAME_MAX_LENGTH) {
    throw BusinessError.validationFailed(
      `name must be at most ${COURSE_NAME_MAX_LENGTH} characters`,
      { field: 'name', length: name.length },
    );
  }
}

function assertPackageName(name: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw BusinessError.validationFailed('name is required', { field: 'name' });
  }
  if (name.length > PACKAGE_NAME_MAX_LENGTH) {
    throw BusinessError.validationFailed(
      `name must be at most ${PACKAGE_NAME_MAX_LENGTH} characters`,
      { field: 'name', length: name.length },
    );
  }
}

function assertCourseType(type: string): asserts type is keyof typeof COURSE_TYPE {
  if (!VALID_COURSE_TYPES.has(type)) {
    throw BusinessError.validationFailed('type must be CLASS or ONE_TO_ONE', {
      field: 'type',
      value: type,
    });
  }
}

function assertDescription(description: string): void {
  if (typeof description !== 'string') {
    throw BusinessError.validationFailed('description is required', {
      field: 'description',
    });
  }
  // Empty description is allowed (Text column); only the type is enforced.
}
