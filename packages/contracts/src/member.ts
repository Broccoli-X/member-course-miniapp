/**
 * Member / student / guardian-relation contracts.
 *
 * These types are produced and consumed by the admin and mini endpoints in
 * `task-6-brief.md`:
 *   - `GET/POST /api/admin/v1/members[/:id]`
 *   - `POST /api/admin/v1/members/:id/students`
 *   - `PATCH /api/admin/v1/students/:studentId`
 *   - `POST/DELETE /api/admin/v1/students/:studentId/relations[/...]`
 *   - `GET /api/mini/v1/me`
 *   - `GET/POST /api/mini/v1/students[/:studentId]`
 *   - `PATCH /api/mini/v1/students/:studentId`
 *
 * They are framework-agnostic so the same shapes can be re-used by the
 * miniprogram client and automated tests.
 */

// ── Enumerations (string-literal unions; the schema stores free-form strings) ──

/** Status values for {@link MemberAccount.status}. */
export const MEMBER_STATUS = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type MemberStatus = (typeof MEMBER_STATUS)[keyof typeof MEMBER_STATUS];

/** Status values for {@link StudentProfile.status}. */
export const STUDENT_STATUS = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type StudentStatus = (typeof STUDENT_STATUS)[keyof typeof STUDENT_STATUS];

/**
 * Relation type stored on `AccountStudentRelation.relationType`.
 *
 * `SELF` means the member IS the student; `GUARDIAN`/`PARENT` means the member
 * is a parent or legal guardian of the student. The brief refers to "second
 * guardian" linking, which is admin-only and records `verifiedByAdminId`.
 */
export const RELATION_TYPE = {
  SELF: 'SELF',
  GUARDIAN: 'GUARDIAN',
  PARENT: 'PARENT',
} as const;
export type RelationType = (typeof RELATION_TYPE)[keyof typeof RELATION_TYPE];

/**
 * The relationship a member asserts when self-creating a student profile via
 * `POST /api/mini/v1/students`. Only `SELF` and `GUARDIAN` are accepted from
 * the mini-program client; admin-side relation linking uses the full
 * {@link RelationType} union.
 */
export type MemberSelfServiceRelation = typeof RELATION_TYPE.SELF | typeof RELATION_TYPE.GUARDIAN;

// ── Wire shapes ──────────────────────────────────────────────────────────

/** Serializable representation of a member account. */
export interface MemberAccountView {
  readonly id: string;
  readonly normalizedPhone: string | null;
  readonly status: MemberStatus | string;
  readonly isProvisional: boolean;
  readonly version: number;
}

/** Serializable representation of a student profile. */
export interface StudentProfileView {
  readonly id: string;
  readonly displayName: string;
  /** ISO date string (`YYYY-MM-DD`) or null. */
  readonly birthDate: string | null;
  readonly status: StudentStatus | string;
  readonly version: number;
}

/** Serializable representation of an account-student relation. */
export interface AccountStudentRelationView {
  readonly id: string;
  readonly accountId: string;
  readonly studentId: string;
  readonly relationType: RelationType | string;
  readonly verifiedByAdminId: string | null;
  readonly version: number;
}

/** Member detail shape returned by `GET /api/admin/v1/members/:id`. */
export interface MemberDetailView {
  readonly account: MemberAccountView;
  readonly students: ReadonlyArray<StudentProfileView & {
    readonly relation: AccountStudentRelationView;
  }>;
}

/** Member self-summary returned by `GET /api/mini/v1/me`. */
export interface MemberSelfView {
  readonly account: MemberAccountView;
  readonly relationships: ReadonlyArray<RelationType | string>;
}

/** A student as seen by a bound member (profile + the caller's relation). */
export interface MemberStudentView {
  readonly student: StudentProfileView;
  readonly relation: AccountStudentRelationView;
}

// ── Admin request bodies ─────────────────────────────────────────────────

/** Body of `POST /api/admin/v1/members`. */
export interface CreateMemberRequest {
  readonly normalizedPhone: string;
  readonly status?: MemberStatus;
}

/** Body of `POST /api/admin/v1/members/:id/students`. */
export interface AdminCreateStudentRequest {
  readonly displayName: string;
  readonly birthDate?: string | null;
  readonly relationType: RelationType;
}

/** Body of `PATCH /api/admin/v1/students/:studentId`. */
export interface AdminUpdateStudentRequest {
  readonly displayName?: string;
  readonly birthDate?: string | null;
  readonly status?: StudentStatus;
}

/** Body of `POST /api/admin/v1/students/:studentId/relations`. */
export interface AdminLinkRelationRequest {
  readonly accountId: string;
  readonly relationType: RelationType;
}

// ── Mini request bodies ──────────────────────────────────────────────────

/** Body of `POST /api/mini/v1/students`. */
export interface MemberCreateStudentRequest {
  readonly displayName: string;
  readonly birthDate?: string | null;
  /**
   * The relationship the member asserts over the new student. `SELF` means the
   * member IS the student (one active SELF per member enforced); `GUARDIAN`
   * means the member is a parent/guardian of the student.
   */
  readonly relationship: MemberSelfServiceRelation;
}

/** Body of `PATCH /api/mini/v1/students/:studentId`. */
export interface MemberUpdateStudentRequest {
  readonly displayName?: string;
  readonly birthDate?: string | null;
}

// ── Results (service layer; richer than the wire views where useful) ─────

/** Result of creating a student + relation in one transaction. */
export interface CreateStudentResult {
  readonly student: StudentProfileView;
  readonly relation: AccountStudentRelationView;
}
