/**
 * Course / package catalog contracts.
 *
 * Produced and consumed by the admin and mini endpoints in `task-7-brief.md`:
 *   - `GET    /api/admin/v1/courses`
 *   - `POST   /api/admin/v1/courses`
 *   - `PATCH  /api/admin/v1/courses/:id`
 *   - `POST   /api/admin/v1/courses/:id/archive`
 *   - `POST   /api/admin/v1/courses/:courseId/package-products`
 *   - `PATCH  /api/admin/v1/package-products/:id`
 *   - `POST   /api/admin/v1/package-products/:id/archive`
 *   - `GET    /api/mini/v1/courses`
 *   - `GET    /api/mini/v1/courses/:id`
 *
 * Decimal values (price/hours) are carried as strings on the wire — the global
 * constraint forbids representing money/hours as a JavaScript `number`. They are
 * parsed with `Prisma.Decimal` at the boundary.
 */

// ── Enumerations (string-literal unions; the schema stores free-form strings) ──

/** Status values for {@link Course.status} and {@link PackageProductView.status}. */
export const CATALOG_STATUS = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type CatalogStatus = (typeof CATALOG_STATUS)[keyof typeof CATALOG_STATUS];

/**
 * M1 course types. `CLASS` is a group class; `ONE_TO_ONE` is a private lesson.
 * Policy versions (M2) start later — do NOT extend this union with policy-only
 * types here.
 */
export const COURSE_TYPE = {
  CLASS: 'CLASS',
  ONE_TO_ONE: 'ONE_TO_ONE',
} as const;
export type CourseType = (typeof COURSE_TYPE)[keyof typeof COURSE_TYPE];

// ── Wire shapes ──────────────────────────────────────────────────────────

/**
 * Serializable representation of a course. Admin views see all rows; mini views
 * see only ACTIVE rows (ARCHIVED is hidden from the mini program).
 */
export interface CourseView {
  readonly id: string;
  readonly name: string;
  readonly type: CourseType | string;
  readonly description: string;
  readonly status: CatalogStatus | string;
  readonly version: number;
}

/**
 * Serializable representation of a package product. Money (`price`) and lesson
 * quantity (`hours`) are strings to preserve decimal precision across JSON.
 */
export interface PackageProductView {
  readonly id: string;
  readonly courseId: string;
  readonly name: string;
  /** Decimal string (2 dp), e.g. `"100.00"`. */
  readonly price: string;
  /** Decimal string (2 dp), e.g. `"10.00"`. Always strictly positive. */
  readonly hours: string;
  readonly validDays: number;
  readonly status: CatalogStatus | string;
  readonly version: number;
}

/** Course with its packages — the shape returned by mini course detail. */
export interface CourseWithPackagesView {
  readonly course: CourseView;
  readonly packages: ReadonlyArray<PackageProductView>;
}

// ── Admin request bodies ─────────────────────────────────────────────────

/** Body of `POST /api/admin/v1/courses`. */
export interface CreateCourseRequest {
  readonly name: string;
  readonly type: CourseType;
  readonly description: string;
}

/** Body of `PATCH /api/admin/v1/courses/:id`. All fields optional. */
export interface UpdateCourseRequest {
  readonly name?: string;
  readonly type?: CourseType;
  readonly description?: string;
}

/** Body of `POST /api/admin/v1/courses/:courseId/package-products`. */
export interface CreatePackageProductRequest {
  readonly name: string;
  /** Decimal string, at most 2 fractional digits, e.g. `"100.00"`. */
  readonly price: string;
  /** Decimal string, at most 2 fractional digits, strictly positive. */
  readonly hours: string;
  /** Positive integer. */
  readonly validDays: number;
}

/** Body of `PATCH /api/admin/v1/package-products/:id`. All fields optional. */
export interface UpdatePackageProductRequest {
  readonly name?: string;
  readonly price?: string;
  readonly hours?: string;
  readonly validDays?: number;
}
