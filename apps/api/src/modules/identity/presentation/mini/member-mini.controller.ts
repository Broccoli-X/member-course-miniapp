import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ERROR_CODES,
  type MemberCreateStudentRequest,
  type MemberPrincipal,
  type MemberSelfView,
  type MemberStudentView,
  type MemberUpdateStudentRequest,
  type RelationType,
} from '@member-course/contracts';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service.js';
import { StudentProfileService, toStudentView } from '../../application/student-profile.service.js';
import { StudentAccessService } from '../../application/student-access.service.js';
import { AccountStudentRelationService } from '../../application/account-student-relation.service.js';
import { BusinessError } from '../../../../common/errors/business-error.js';
import { MiniAuthGuard } from './mini-auth.guard.js';
import { BoundMemberGuard } from './bound-member.guard.js';
import {
  MemberCreateStudentDto,
  MemberCreateStudentResponseDto,
  MemberStudentResponseDto,
  MemberUpdateStudentDto,
} from './dto/student-profile.dto.js';

/**
 * Mini-program (member) private endpoints.
 *
 * Path prefix `mini/v1` combines with the global `/api` prefix to produce:
 *   - `GET   /api/mini/v1/me`
 *   - `GET   /api/mini/v1/students`
 *   - `POST  /api/mini/v1/students`
 *   - `GET   /api/mini/v1/students/:studentId`
 *   - `PATCH /api/mini/v1/students/:studentId`
 *
 * Every route uses BOTH {@link MiniAuthGuard} (verifies the member access
 * token) AND {@link BoundMemberGuard} (reloads the live MemberAccount row and
 * rejects provisional/unbound members). This wires the BoundMemberGuard that
 * Task 5 created but left unwired.
 *
 * Note: there is intentionally NO `POST /mini/v1/students/:id/relations` —
 * self-service secondary guardian linking is forbidden by the brief. The
 * only way to attach a second account to a student is the admin route, which
 * a member's token cannot satisfy (wrong JWT `kind`).
 */
@UseGuards(MiniAuthGuard, BoundMemberGuard)
@Controller('mini/v1')
export class MemberMiniController {
  constructor(
    private readonly db: PrismaService,
    private readonly students: StudentProfileService,
    private readonly access: StudentAccessService,
  ) {}

  // ── /me ────────────────────────────────────────────────────────────────

  @Get('me')
  @HttpCode(HttpStatus.OK)
  async me(
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
  ): Promise<MemberSelfView> {
    const principal = req.memberPrincipal!;
    const account = await this.db.memberAccount.findUniqueOrThrow({
      where: { id: principal.accountId },
    });
    const relationRows = await this.db.accountStudentRelation.findMany({
      where: { accountId: principal.accountId },
      select: { relationType: true },
    });
    // Deduplicate the relationship list (e.g. a member with two GUARDIAN
    // children shows ['SELF','GUARDIAN'], not ['GUARDIAN','GUARDIAN']).
    const relationships = Array.from(
      new Set(relationRows.map((r) => r.relationType)),
    );
    return {
      account: {
        id: account.id,
        normalizedPhone: account.normalizedPhone,
        status: account.status,
        isProvisional: account.isProvisional,
        version: account.version,
      },
      relationships,
    };
  }

  // ── Students ───────────────────────────────────────────────────────────

  @Get('students')
  @HttpCode(HttpStatus.OK)
  async listStudents(
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
  ): Promise<MemberStudentView[]> {
    const principal = req.memberPrincipal!;
    const rows = await this.db.accountStudentRelation.findMany({
      where: { accountId: principal.accountId },
      include: { student: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      student: toStudentView(r.student),
      relation: AccountStudentRelationService.toView(r),
    }));
  }

  @Post('students')
  @HttpCode(HttpStatus.CREATED)
  async createStudent(
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
    @Body() body: MemberCreateStudentDto,
  ): Promise<MemberCreateStudentResponseDto> {
    const principal = req.memberPrincipal!;
    const result = await this.students.createForMember({
      accountId: principal.accountId,
      displayName: body.displayName,
      birthDate: body.birthDate,
      relationType: body.relationship as RelationType,
    });
    return result;
  }

  @Get('students/:studentId')
  @HttpCode(HttpStatus.OK)
  async getStudent(
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
    @Param('studentId') studentId: string,
  ): Promise<MemberStudentResponseDto> {
    const principal = req.memberPrincipal!;
    // Core authorization gate — throws STUDENT_FORBIDDEN (403) if unrelated.
    await this.access.assertRelated(principal.accountId, studentId);

    const relation = await this.db.accountStudentRelation.findUnique({
      where: {
        accountId_studentId: { accountId: principal.accountId, studentId },
      },
      include: { student: true },
    });
    // Defensive: assertRelated passed so the row exists, but a race could
    // delete it between the check and the read. Treat as forbidden, not a 500.
    if (!relation) {
      throw BusinessError.forbidden(
        ERROR_CODES.STUDENT_FORBIDDEN,
        'Student not accessible',
        { accountId: principal.accountId, studentId },
      );
    }
    return {
      student: toStudentView(relation.student),
      relation: AccountStudentRelationService.toView(relation),
    };
  }

  @Patch('students/:studentId')
  @HttpCode(HttpStatus.OK)
  async updateStudent(
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
    @Param('studentId') studentId: string,
    @Body() body: MemberUpdateStudentDto,
  ): Promise<{ student: Awaited<ReturnType<StudentProfileService['update']>> }> {
    const principal = req.memberPrincipal!;
    // Core authorization gate — throws STUDENT_FORBIDDEN (403) if unrelated.
    await this.access.assertRelated(principal.accountId, studentId);

    const student = await this.students.update({
      studentId,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.birthDate !== undefined ? { birthDate: body.birthDate } : {}),
    });
    return { student };
  }
}

// Re-exported so the controller's response shape matches the contract type
// without re-importing the request type from contracts in two places.
export type { MemberCreateStudentRequest, MemberUpdateStudentRequest };
