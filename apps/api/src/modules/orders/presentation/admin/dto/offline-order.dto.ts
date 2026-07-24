/**
 * Request DTOs for the admin offline-order endpoints (Task 9).
 *
 * These mirror the contract command shapes. Validation of existence/active-
 * status rules happens in the service layer (it needs DB access); the DTOs
 * carry the raw wire values. Decimal fields (price/hours) are strings.
 */

/** One line in `POST /api/admin/v1/orders`. */
export class CreateOfflineOrderItemDto {
  /** StudentProfile id this item grants hours to. */
  studentId!: string;
  /** PackageProduct id (ACTIVE) whose snapshot to freeze. */
  productId!: string;
}

/** Body of `POST /api/admin/v1/orders` — create a PENDING draft. */
export class CreateOfflineOrderDto {
  /** MemberAccount id of the buyer. */
  buyerAccountId!: string;
  /** One or more order lines. */
  items!: CreateOfflineOrderItemDto[];
}

/** Body of `POST /api/admin/v1/orders/:id/reverse`. All fields optional. */
export class ReverseOfflineOrderDto {
  /** Optional human-readable reason recorded on the reversal posting(s). */
  reason?: string;
}
