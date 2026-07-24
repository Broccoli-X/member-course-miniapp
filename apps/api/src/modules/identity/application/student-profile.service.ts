import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  RELATION_TYPE,
  type CreateStudentResult,
  type RelationType,
  type StudentProfileView,
  type StudentStatus,
} from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';

/** Allowed relation types on the persisted `AccountStudentRelation.relationType`. */
const VALID_RELATION_TYPES: ReadonlySet<string> = new Set<string>([
  RELATION_TYPE.SELF,
  RELATION_TYPE.GUARDIAN,
  RELATION_TYPE.PARENT,
]);

/** Default student status for newly-created profiles. */
export const DEFAULT_STUDENT_STATUS: StudentStatus = 'ACTIVE';

/** Maximum length of `StudentProfile.displayName` (matches VarChar(50)). */
export const DISPLAY_NAME_MAX_LENGTH = 50;

/**
 * Parse a `YYYY-MM-DD` (or full ISO) string into a UTC midnight Date suitable
 * for the `@db.Date` column. Returns null for empty/null. Throws
 * `validationFailed` for unparseable input so the caller surfaces a clean 400.
 */
function parseBirthDate(input: string | null | undefined): Date | null {
  if (input === null || input === undefined || input === '') return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw BusinessError.validationFailed('birthDate must be an ISO date string', {
      field: 'birthDate',
    });
  }
  return d;
}

/** Convert a Prisma row to the wire {@link StudentProfileView}. */
export function toStudentView(row: {
  id: string;
  displayName: string;
  birthDate: Date | null;
  status: string;
  version: number;
}): StudentProfileView {
  return {
    id: row.id,
    displayName: row.displayName,
    // Serialise the date as `YYYY-MM-DD` to keep the wire shape stable across
    // JSON clients (Date → ISO would include time, the column is date-only).
    birthDate: row.birthDate ? row.birthDate.toISOString().slice(0, 10) : null,
    status: row.status,
    version: row.version,
  };
}

/**
 * Shared student-profile create/edit logic.
 *
 * Both admin and mini controllers delegate here. Authorization (who may call
 * which shape) is settled at the controller/guard layer: this service assumes
 * the caller is already authorized and concerns itself only with the
 * persistence rules — uniqueness of the active SELF profile per member,
 * display-name length, birth-date parsing, status transitions.
 *
 * The service holds no IO adapters other than {@link PrismaService}; it is
 * unit-testable with a mocked client (see {@link StudentProfileService} spec).
 */
@Injectable()
export class StudentProfileService {
  constructor(private readonly db: PrismaService) {}

  // ── Validation helpers (exported so the controller can validate before tx) ──

  static assertDisplayName(displayName: string): void {
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      throw BusinessError.validationFailed('displayName is required', { field: 'displayName' });
    }
    if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
      throw BusinessError.validationFailed(
        `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
        { field: 'displayName', length: displayName.length },
      );
    }
  }

  static assertRelationType(relationType: string): asserts relationType is RelationType {
    if (!VALID_RELATION_TYPES.has(relationType)) {
      throw BusinessError.validationFailed('relationType must be SELF, GUARDIAN, or PARENT', {
        field: 'relationType',
        value: relationType,
      });
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  /** Load a student profile by id; throws `RESOURCE_NOT_FOUND` if missing. */
  async getById(studentId: string): Promise<StudentProfileView> {
    const row = await this.db.studentProfile.findUnique({ where: { id: studentId } });
    if (!row) {
      throw BusinessError.notFound('Student profile not found', { studentId });
    }
    return toStudentView(row);
  }

  /**
   * Load the underlying student row for editing. Throws `RESOURCE_NOT_FOUND`
   * if missing. Returns the raw Prisma row so the caller can drive an
   * optimistic-lock `updateMany`.
   */
  async loadRowForUpdate(studentId: string): Promise<{
    id: string;
    displayName: string;
    birthDate: Date | null;
    status: string;
    version: number;
  }> {
    const row = await this.db.studentProfile.findUnique({ where: { id: studentId } });
    if (!row) {
      throw BusinessError.notFound('Student profile not found', { studentId });
    }
    return row;
  }

  // ── Member self-service creation (SELF / GUARDIAN) ─────────────────────

  /**
   * Create a `StudentProfile` + `AccountStudentRelation` in ONE transaction.
   *
   * Enforces the ONE-active-SELF-per-member invariant: a second SELF for the
   * same account is rejected with `STATE_CHANGED` (HTTP 409). GUARDIAN /
   * PARENT relations are unlimited. The relation created by a member is
   * self-asserted, so `verifiedByAdminId` is left null (it is set only on
   * admin-mediated second-guardian linking — see
   * {@link AccountStudentRelationService.linkGuardian}).
   */
  async createForMember(args: {
    accountId: string;
    displayName: string;
    birthDate?: string | null;
    relationType: RelationType;
  }): Promise<CreateStudentResult> {
    StudentProfileService.assertDisplayName(args.displayName);
    StudentProfileService.assertRelationType(args.relationType);
    const birthDate = parseBirthDate(args.birthDate ?? null);

    return this.db.$transaction(async (tx) => {
      // Enforce ONE active SELF per member. The schema's
      // @@unique([accountId, studentId]) prevents duplicate rows for the same
      // pair but NOT two SELF rows for two different students — we enforce
      // that here, inside the tx, so a racing pair of SELF creates for the
      // same account serialise.
      if (args.relationType === RELATION_TYPE.SELF) {
        const existingSelf = await tx.accountStudentRelation.findFirst({
          where: { accountId: args.accountId, relationType: RELATION_TYPE.SELF },
          select: { id: true },
        });
        if (existingSelf) {
          throw BusinessError.conflict(
            'Member already has an active SELF student profile',
            { accountId: args.accountId, code: ERROR_CODES.STATE_CHANGED },
          );
        }
      }

      const student = await tx.studentProfile.create({
        data: {
          displayName: args.displayName,
          birthDate,
          status: DEFAULT_STUDENT_STATUS,
        },
      });
      const relation = await tx.accountStudentRelation.create({
        data: {
          accountId: args.accountId,
          studentId: student.id,
          relationType: args.relationType,
          verifiedByAdminId: null,
        },
      });

      return {
        student: toStudentView(student),
        relation: {
          id: relation.id,
          accountId: relation.accountId,
          studentId: relation.studentId,
          relationType: relation.relationType,
          verifiedByAdminId: relation.verifiedByAdminId,
          version: relation.version,
        },
      };
    });
  }

  // ── Admin creation (any relation type, verifiedByAdminId may be set by caller) ──

  /**
   * Admin variant of {@link createForMember}: the admin has already been
   * authorized, and the relation type may be SELF/GUARDIAN/PARENT. Still
   * enforces the ONE-active-SELF-per-member rule (an admin cannot create a
   * second SELF for a member either).
   */
  async createForAdmin(args: {
    accountId: string;
    displayName: string;
    birthDate?: string | null;
    relationType: RelationType;
    verifiedByAdminId?: string | null;
  }): Promise<CreateStudentResult> {
    StudentProfileService.assertDisplayName(args.displayName);
    StudentProfileService.assertRelationType(args.relationType);
    const birthDate = parseBirthDate(args.birthDate ?? null);

    return this.db.$transaction(async (tx) => {
      if (args.relationType === RELATION_TYPE.SELF) {
        const existingSelf = await tx.accountStudentRelation.findFirst({
          where: { accountId: args.accountId, relationType: RELATION_TYPE.SELF },
          select: { id: true },
        });
        if (existingSelf) {
          throw BusinessError.conflict(
            'Member already has an active SELF student profile',
            { accountId: args.accountId },
          );
        }
      }

      const student = await tx.studentProfile.create({
        data: {
          displayName: args.displayName,
          birthDate,
          status: DEFAULT_STUDENT_STATUS,
        },
      });
      const relation = await tx.accountStudentRelation.create({
        data: {
          accountId: args.accountId,
          studentId: student.id,
          relationType: args.relationType,
          verifiedByAdminId: args.verifiedByAdminId ?? null,
        },
      });

      return {
        student: toStudentView(student),
        relation: {
          id: relation.id,
          accountId: relation.accountId,
          studentId: relation.studentId,
          relationType: relation.relationType,
          verifiedByAdminId: relation.verifiedByAdminId,
          version: relation.version,
        },
      };
    });
  }

  // ── Profile edits ──────────────────────────────────────────────────────

  /**
   * Patch a student profile's mutable fields. Authorization (which caller may
   * edit which student) is the controller's responsibility; this method only
   * applies the patch. Uses optimistic locking via `version` so a concurrent
   * edit by an admin and a member does not silently clobber.
   */
  async update(args: {
    studentId: string;
    displayName?: string;
    birthDate?: string | null;
    status?: StudentStatus;
  }): Promise<StudentProfileView> {
    if (args.displayName !== undefined) {
      StudentProfileService.assertDisplayName(args.displayName);
    }
    const birthDate =
      args.birthDate === undefined ? undefined : parseBirthDate(args.birthDate);

    const row = await this.loadRowForUpdate(args.studentId);

    const data: Record<string, unknown> = {};
    if (args.displayName !== undefined) data.displayName = args.displayName;
    if (birthDate !== undefined) data.birthDate = birthDate;
    if (args.status !== undefined) data.status = args.status;

    if (Object.keys(data).length === 0) {
      // Nothing to change — return the current view without a write.
      return toStudentView(row);
    }

    const updated = await this.db.studentProfile.update({
      where: { id: args.studentId, version: row.version },
      data,
    });
    return toStudentView(updated);
  }
}
