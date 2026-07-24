import { Injectable } from '@nestjs/common';
import {
  type CreateMemberRequest,
  type CreateStudentResult,
  type MemberAccountView,
  type RelationType,
} from '@member-course/contracts';
import { ERROR_CODES, HTTP_STATUS } from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import { normalizePhone, NORMALIZED_PHONE_MAX_LENGTH } from '../domain/phone.js';
import { StudentProfileService } from './student-profile.service.js';

/** Allowed status values for admin member creation. */
const VALID_MEMBER_STATUSES: ReadonlySet<string> = new Set<string>(['ACTIVE', 'SUSPENDED']);

/**
 * Admin member write-side operations.
 *
 * Creates admin-pre-created member accounts (the accounts members later merge
 * into via phone binding) and creates students on behalf of a member. The
 * service holds no IO adapters other than {@link PrismaService}.
 */
@Injectable()
export class MemberAdminService {
  constructor(
    private readonly db: PrismaService,
    private readonly students: StudentProfileService,
  ) {}

  /**
   * Create an admin-pre-created member account. `isProvisional=false` so the
   * account is immediately "real" once a member binds the matching phone.
   * Throws `STATE_CHANGED` (409) if the phone is already in use — the
   * `normalizedPhone` column is `@unique`.
   */
  async create(args: CreateMemberRequest): Promise<MemberAccountView> {
    let normalizedPhone: string;
    try {
      normalizedPhone = normalizePhone(args.normalizedPhone);
    } catch (e) {
      throw BusinessError.validationFailed(
        `Invalid phone: ${(e as Error).message}`,
        { field: 'normalizedPhone' },
      );
    }
    if (normalizedPhone.length > NORMALIZED_PHONE_MAX_LENGTH) {
      throw BusinessError.validationFailed(
        `Phone exceeds ${NORMALIZED_PHONE_MAX_LENGTH} digits`,
        { field: 'normalizedPhone' },
      );
    }
    const status = (args.status ?? 'ACTIVE') as string;
    if (!VALID_MEMBER_STATUSES.has(status)) {
      throw BusinessError.validationFailed('status must be ACTIVE or SUSPENDED', {
        field: 'status',
        value: status,
      });
    }

    const existing = await this.db.memberAccount.findUnique({
      where: { normalizedPhone },
      select: { id: true },
    });
    if (existing) {
      throw new BusinessError(
        ERROR_CODES.STATE_CHANGED,
        'A member with this phone already exists',
        HTTP_STATUS.CONFLICT,
        { normalizedPhone },
      );
    }

    const account = await this.db.memberAccount.create({
      data: {
        normalizedPhone,
        status: status as string,
        isProvisional: false,
      },
    });
    return {
      id: account.id,
      normalizedPhone: account.normalizedPhone,
      status: account.status,
      isProvisional: account.isProvisional,
      version: account.version,
    };
  }

  /**
   * Admin creates a student profile and links it to `memberId`. Delegates to
   * {@link StudentProfileService.createForAdmin} for the SELF-uniqueness rule
   * and the profile+relation transaction.
   */
  async createStudentForMember(args: {
    memberId: string;
    displayName: string;
    birthDate?: string | null;
    relationType: RelationType;
    verifiedByAdminId: string;
  }): Promise<CreateStudentResult> {
    // Validate the member exists.
    const account = await this.db.memberAccount.findUnique({
      where: { id: args.memberId },
      select: { id: true },
    });
    if (!account) {
      throw BusinessError.notFound('Member not found', { memberId: args.memberId });
    }
    return this.students.createForAdmin({
      accountId: args.memberId,
      displayName: args.displayName,
      birthDate: args.birthDate,
      relationType: args.relationType,
      verifiedByAdminId: args.verifiedByAdminId,
    });
  }
}
