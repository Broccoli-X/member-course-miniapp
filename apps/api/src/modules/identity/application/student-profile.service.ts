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
import { Prisma } from '../../../generated/prisma/client.js';

/** Allowed relation types on the persisted `AccountStudentRelation.relationType`. */
const VALID_RELATION_TYPES: ReadonlySet<string> = new Set<string>([
  RELATION_TYPE.SELF,
  RELATION_TYPE.GUARDIAN,
  RELATION_TYPE.PARENT,
]);

/**
 * Relation types a mini-program member may self-assert when creating a student.
 * `PARENT` is admin-mediated only (the brief says members create "self and
 * child profiles" → SELF + GUARDIAN; see `member.ts` contract note).
 */
const SELF_SERVICE_RELATION_TYPES: ReadonlySet<string> = new Set<string>([
  RELATION_TYPE.SELF,
  RELATION_TYPE.GUARDIAN,
]);

/**
 * Max retries for the SELF-create transaction when MySQL reports a deadlock
 * (Prisma error `P2034`). Under REPEATABLE READ the `SELECT ... FOR UPDATE`
 * SELF guard takes a gap lock when no SELF row exists yet; two concurrent
 * SELF creates can then deadlock (each holds the gap lock the other's INSERT
 * needs). MySQL picks one as the victim and Prisma surfaces `P2034` with the
 * instruction "Please retry your transaction." On retry the loser re-runs the
 * locking read, observes the now-committed SELF row from the winner, and
 * throws a clean `STATE_CHANGED` (409) — deterministic one-winner/one-loser.
 */
const DEADLOCK_RETRY_MAX = 3;

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

  /**
   * Mini-path relation validator. Accepts ONLY `SELF` and `GUARDIAN` — `PARENT`
   * is an admin-mediated relation type and must not be self-asserted by a
   * mini-program client (contract: `member.ts` — "Only SELF and GUARDIAN are
   * accepted from the mini-program client").
   */
  static assertSelfServiceRelationType(
    relationType: string,
  ): asserts relationType is typeof RELATION_TYPE.SELF | typeof RELATION_TYPE.GUARDIAN {
    if (!SELF_SERVICE_RELATION_TYPES.has(relationType)) {
      throw BusinessError.validationFailed(
        'relationship must be SELF or GUARDIAN',
        { field: 'relationship', value: relationType },
      );
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

  // ── Member self-service creation (SELF / GUARDIAN only) ───────────────

  /**
   * Mini-program member self-service create. Accepts ONLY `SELF` and
   * `GUARDIAN` (PARENT is admin-mediated — see contract `member.ts`). The
   * relation is self-asserted, so `verifiedByAdminId` is null (it is set only
   * on admin-mediated second-guardian linking — see
   * {@link AccountStudentRelationService.linkGuardian}).
   */
  async createForMember(args: {
    accountId: string;
    displayName: string;
    birthDate?: string | null;
    relationType: RelationType;
  }): Promise<CreateStudentResult> {
    StudentProfileService.assertDisplayName(args.displayName);
    StudentProfileService.assertSelfServiceRelationType(args.relationType);
    return this.create({ ...args, verifiedByAdminId: null });
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
    return this.create({ ...args, verifiedByAdminId: args.verifiedByAdminId ?? null });
  }

  /**
   * Shared create used by both {@link createForMember} (mini, verifiedByAdminId
   * null, SELF/GUARDIAN only) and {@link createForAdmin} (admin, any relation
   * type, verifiedByAdminId may be set). The caller is responsible for the
   * relation-type scope check; this method assumes `relationType` is valid.
   *
   * Enforces the ONE-active-SELF-per-member invariant with a race-safe
   * `SELECT ... FOR UPDATE` inside the SAME interactive transaction that does
   * the insert. A plain `findFirst` (the original implementation) is a
   * non-locking consistent read, so two concurrent SELF creates for the same
   * account would both read (no SELF) and both insert with distinct
   * `studentId`s — the schema's `@@unique([accountId, studentId])` does NOT
   * fire (different studentIds), yielding TWO SELF relations. `FOR UPDATE`
   * serializes the two transactions against the matching row (or the index gap
   * when none exists yet) under MySQL's default REPEATABLE READ.
   *
   * Because gap locks are involved, two concurrent SELF creates can still
   * DEADLOCK (each tx's gap lock blocks the other's INSERT). MySQL aborts one
   * transaction as the deadlock victim; Prisma surfaces this as error `P2034`
   * ("Please retry your transaction"). We therefore wrap the tx in a small
   * retry loop: on `P2034` the loser re-runs the locking read, now observes the
   * winner's committed SELF row, and throws a clean `STATE_CHANGED` (409) —
   * yielding deterministic one-winner / one-loser behaviour.
   */
  private async create(args: {
    accountId: string;
    displayName: string;
    birthDate?: string | null;
    relationType: RelationType;
    verifiedByAdminId: string | null;
  }): Promise<CreateStudentResult> {
    const birthDate = parseBirthDate(args.birthDate ?? null);

    // The body throws BusinessError for invariant violations; those MUST NOT
    // be retried. Only Prisma `P2034` (deadlock) is retried.
    const runTx = () =>
      this.db.$transaction(async (tx) => {
        if (args.relationType === RELATION_TYPE.SELF) {
          // Race-safe locking read. Tagged-template $queryRaw passes
          // accountId as a bound parameter (no SQL injection).
          const existingSelf = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM account_student_relation
            WHERE accountId = ${args.accountId} AND relationType = ${RELATION_TYPE.SELF}
            FOR UPDATE
          `;
          if (existingSelf.length > 0) {
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
            verifiedByAdminId: args.verifiedByAdminId,
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

    return this.runWithDeadlockRetry(runTx);
  }

  /**
   * Run `fn` and retry it on Prisma `P2034` (transaction deadlock / write
   * conflict) up to {@link DEADLOCK_RETRY_MAX} times. `BusinessError`s and all
   * other errors propagate unchanged. A tiny backoff keeps retries polite
   * under bursty contention.
   */
  private async runWithDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= DEADLOCK_RETRY_MAX; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        // Only the Prisma deadlock/write-conflict code is retryable.
        const isDeadlock =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
        if (!isDeadlock) throw err;
        // Brief backoff before the next attempt.
        await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
      }
    }
    throw lastError;
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
