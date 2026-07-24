import { Injectable } from '@nestjs/common';
import {
  type AccountStudentRelationView,
  type RelationType,
} from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import { StudentProfileService } from './student-profile.service.js';

/**
 * Admin-mediated account↔student relation linking.
 *
 * Per the brief, ONLY administrators may add or remove a SECOND guardian for
 * a student, and they must record `verifiedByAdminId`. Self-service secondary
 * guardian linking is forbidden — there is no mini-side equivalent route, so
 * a member cannot attach another account to their student.
 *
 * The `@@unique([accountId, studentId])` constraint guarantees a given
 * (account, student) pair has at most one relation row, so re-linking the
 * same guardian is idempotent-ish: it raises a unique-violation, which we
 * surface as a 409 conflict.
 */
@Injectable()
export class AccountStudentRelationService {
  constructor(
    private readonly db: PrismaService,
    private readonly students: StudentProfileService,
  ) {}

  /** Convert a Prisma relation row to the wire view. */
  static toView(row: {
    id: string;
    accountId: string;
    studentId: string;
    relationType: string;
    verifiedByAdminId: string | null;
    version: number;
  }): AccountStudentRelationView {
    return {
      id: row.id,
      accountId: row.accountId,
      studentId: row.studentId,
      relationType: row.relationType,
      verifiedByAdminId: row.verifiedByAdminId,
      version: row.version,
    };
  }

  /**
   * Admin links a guardian (`accountId`) to `studentId`, recording
   * `verifiedByAdminId`. Throws:
   *  - `RESOURCE_NOT_FOUND` if the student or account does not exist.
   *  - `STATE_CHANGED` (409) if the relation already exists (unique pair).
   *
   * Returns the created relation. The caller (controller) supplies the admin
   * principal's id as `verifiedByAdminId` — this service does NOT trust the
   * request body for that field.
   */
  async linkGuardian(args: {
    studentId: string;
    accountId: string;
    relationType: RelationType;
    verifiedByAdminId: string;
  }): Promise<AccountStudentRelationView> {
    // Validate the student exists (throws RESOURCE_NOT_FOUND otherwise).
    await this.students.getById(args.studentId);
    // Validate the target account exists.
    const account = await this.db.memberAccount.findUnique({
      where: { id: args.accountId },
      select: { id: true },
    });
    if (!account) {
      throw BusinessError.notFound('Member account not found', { accountId: args.accountId });
    }

    // Reject an already-existing relation (unique pair) up front for a clean
    // 409 instead of relying on the Prisma P2002 surface.
    const existing = await this.db.accountStudentRelation.findUnique({
      where: {
        accountId_studentId: { accountId: args.accountId, studentId: args.studentId },
      },
    });
    if (existing) {
      throw BusinessError.conflict('Relation already exists for this account and student', {
        accountId: args.accountId,
        studentId: args.studentId,
      });
    }

    const relation = await this.db.accountStudentRelation.create({
      data: {
        accountId: args.accountId,
        studentId: args.studentId,
        relationType: args.relationType,
        verifiedByAdminId: args.verifiedByAdminId,
      },
    });
    return AccountStudentRelationService.toView(relation);
  }

  /**
   * Admin removes the relation between `accountId` and `studentId`. Idempotent
   * in the sense that a missing relation surfaces as 404 (the route's intent
   * is to remove a specific tie; a no-op delete would hide bugs).
   */
  async unlinkGuardian(args: {
    studentId: string;
    accountId: string;
  }): Promise<void> {
    const existing = await this.db.accountStudentRelation.findUnique({
      where: {
        accountId_studentId: { accountId: args.accountId, studentId: args.studentId },
      },
    });
    if (!existing) {
      throw BusinessError.notFound('Relation not found', {
        accountId: args.accountId,
        studentId: args.studentId,
      });
    }
    await this.db.accountStudentRelation.delete({ where: { id: existing.id } });
  }
}
