import {
  type CreateCourseRequest,
  type CreatePackageProductRequest,
  type UpdateCourseRequest,
  type UpdatePackageProductRequest,
} from '@member-course/contracts';

/**
 * Plain DTOs for the admin catalog endpoints. Mirrors the catalog contracts;
 * kept as classes for future class-validator wiring. Validation is enforced
 * inside the service layer (no global ValidationPipe is registered — see
 * task-4-brief.md), so these are wire-shape markers only.
 */

export class CreateCourseDto implements CreateCourseRequest {
  name!: string;
  type!: 'CLASS' | 'ONE_TO_ONE';
  description!: string;
}

export class UpdateCourseDto implements UpdateCourseRequest {
  name?: string;
  type?: 'CLASS' | 'ONE_TO_ONE';
  description?: string;
}

export class CreatePackageProductDto implements CreatePackageProductRequest {
  name!: string;
  /** Decimal string, at most 2 fractional digits. */
  price!: string;
  /** Decimal string, at most 2 fractional digits, strictly positive. */
  hours!: string;
  /** Positive integer. */
  validDays!: number;
}

export class UpdatePackageProductDto implements UpdatePackageProductRequest {
  name?: string;
  price?: string;
  hours?: string;
  validDays?: number;
}
