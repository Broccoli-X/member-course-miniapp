import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';

/**
 * Student-access authorization primitive.
 *
 * The single rule enforced here: a member account may read/edit a student
 * profile ONLY if an `AccountStudentRelation` row ties the two together. This
 * is the core authorization gate reused by every mini `/students/:id` path so
 * the rule lives in exactly one place — controllers and other services must
 * call {@link assertRelated} (or {@link isRelated}) rather than re-implement
 * the lookup.
 *
 * The check considers a relation active regardless of `relationType` (SELF,
 * GUARDIAN, PARENT) — the relation type governs who the member IS to the
 * student, not whether they may see the profile. `verifiedByAdminId` is also
 * irrelevant to access (it records provenance, not a permission).
 *
 * On denial the service throws `BusinessError.forbidden('STUDENT_FORBIDDEN',
 * ...)`, which the global {@link BusinessErrorFilter} maps to HTTP 403 with
 * body `{ code: 'STUDENT_FORBIDDEN', ... }`. The brief's verbatim
 * "does not reveal an unrelated student" test asserts exactly this shape.
 */
@Injectable()
export class StudentAccessService {
  constructor(private readonly db: PrismaService) {}

  /**
   * True iff an `AccountStudentRelation` row exists for the pair. Active-only
   * by virtue of the schema: relations are hard-deleted (no soft-delete
   * column), so existence == active.
   */
  async isRelated(accountId: string, studentId: string): Promise<boolean> {
    const count = await this.db.accountStudentRelation.count({
      where: { accountId, studentId },
    });
    return count > 0;
  }

  /**
   * Assert the member `accountId` is related to `studentId`. Throws
   * `STUDENT_FORBIDDEN` (HTTP 403) otherwise. The single source of truth for
   * mini student read/edit authorization.
   */
  async assertRelated(accountId: string, studentId: string): Promise<void> {
    const ok = await this.isRelated(accountId, studentId);
    if (!ok) {
      throw BusinessError.forbidden(
        ERROR_CODES.STUDENT_FORBIDDEN,
        'Account is not related to this student',
        { accountId, studentId },
      );
    }
  }
}
