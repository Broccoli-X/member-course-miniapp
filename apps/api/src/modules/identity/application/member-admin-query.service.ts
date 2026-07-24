import { Injectable } from '@nestjs/common';
import {
  type MemberAccountView,
  type MemberDetailView,
  type PaginatedResult,
  type PaginationParams,
} from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import { toStudentView } from './student-profile.service.js';
import { AccountStudentRelationService } from './account-student-relation.service.js';

/** Convert a Prisma MemberAccount row to the wire view. */
function toAccountView(row: {
  id: string;
  normalizedPhone: string | null;
  status: string;
  isProvisional: boolean;
  version: number;
}): MemberAccountView {
  return {
    id: row.id,
    normalizedPhone: row.normalizedPhone,
    status: row.status,
    isProvisional: row.isProvisional,
    version: row.version,
  };
}

/**
 * Admin member read-side queries.
 *
 * Kept separate from {@link MemberAdminService} (the write side) so the read
 * paths are easy to reason about and the write service stays focused on
 * member creation. All methods assume the caller is an authenticated admin
 * (the {@link AdminAuthGuard} on the controller enforces that).
 */
@Injectable()
export class MemberAdminQueryService {
  constructor(private readonly db: PrismaService) {}

  /**
   * Paginated member list. When `phone` is provided, restricts to members
   * whose `normalizedPhone` matches as a prefix (the brief allows exact OR
   * prefix — prefix is the more useful back-office behaviour and includes the
   * exact match). The phone is digit-only-normalized here so `+86 138...`
   * and `138...` both find the same row.
   */
  async list(params: PaginationParams & { phone?: string }): Promise<PaginatedResult<MemberAccountView>> {
    const where = params.phone
      ? { normalizedPhone: { startsWith: params.phone.replace(/\D+/g, '') } }
      : undefined;

    const [total, rows] = await Promise.all([
      this.db.memberAccount.count({ where }),
      this.db.memberAccount.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    return {
      items: rows.map(toAccountView),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages,
    };
  }

  /**
   * Member detail with their students + relations. Throws
   * `RESOURCE_NOT_FOUND` if the member does not exist.
   */
  async detail(memberId: string): Promise<MemberDetailView> {
    const account = await this.db.memberAccount.findUnique({
      where: { id: memberId },
    });
    if (!account) {
      throw BusinessError.notFound('Member not found', { memberId });
    }

    const relations = await this.db.accountStudentRelation.findMany({
      where: { accountId: memberId },
      include: { student: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      account: toAccountView(account),
      students: relations.map((r) => ({
        ...toStudentView(r.student),
        relation: AccountStudentRelationService.toView(r),
      })),
    };
  }
}
