import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  type AdminPrincipal,
  type RelationType,
} from '@member-course/contracts';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { MemberAdminService } from '../../application/member-admin.service.js';
import { MemberAdminQueryService } from '../../application/member-admin-query.service.js';
import { StudentProfileService } from '../../application/student-profile.service.js';
import { AccountStudentRelationService } from '../../application/account-student-relation.service.js';
import { validatePagination } from '../../../../common/http/pagination.dto.js';
import {
  AdminCreateStudentDto,
  AdminCreateStudentResponseDto,
  AdminLinkRelationDto,
  AdminLinkRelationResponseDto,
  AdminMemberDetailResponseDto,
  AdminMemberListResponseDto,
  AdminUpdateStudentDto,
  AdminUpdateStudentResponseDto,
  CreateMemberDto,
  CreateMemberResponseDto,
} from './dto/member-admin.dto.js';

/**
 * Administrator member/student/guardian endpoints.
 *
 * Path prefix `admin/v1` combines with the global `/api` prefix to produce:
 *   - `GET    /api/admin/v1/members`
 *   - `POST   /api/admin/v1/members`
 *   - `GET    /api/admin/v1/members/:id`
 *   - `POST   /api/admin/v1/members/:id/students`
 *   - `PATCH  /api/admin/v1/students/:studentId`
 *   - `POST   /api/admin/v1/students/:studentId/relations`
 *   - `DELETE /api/admin/v1/students/:studentId/relations/:accountId`
 *
 * Every route is guarded by {@link AdminAuthGuard}: a mini-program member
 * token fails the admin-token check (wrong `kind`) and is rejected with 401
 * — so the brief's "self-service secondary guardian links forbidden" test
 * holds (a member cannot reach the relation-link route at all).
 */
@UseGuards(AdminAuthGuard)
@Controller('admin/v1')
export class MemberAdminController {
  constructor(
    private readonly members: MemberAdminService,
    private readonly queries: MemberAdminQueryService,
    private readonly students: StudentProfileService,
    private readonly relations: AccountStudentRelationService,
  ) {}

  // ── Members ────────────────────────────────────────────────────────────

  @Get('members')
  @HttpCode(HttpStatus.OK)
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('phone') phone?: string,
  ): Promise<AdminMemberListResponseDto> {
    const pagination = validatePagination({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
    return this.queries.list({
      page: pagination.page,
      pageSize: pagination.pageSize,
      ...(phone ? { phone } : {}),
    });
  }

  @Post('members')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateMemberDto): Promise<CreateMemberResponseDto> {
    return this.members.create({ normalizedPhone: body.normalizedPhone, status: body.status });
  }

  @Get('members/:id')
  @HttpCode(HttpStatus.OK)
  async detail(@Param('id') id: string): Promise<AdminMemberDetailResponseDto> {
    return this.queries.detail(id);
  }

  @Post('members/:id/students')
  @HttpCode(HttpStatus.CREATED)
  async createStudent(
    @Param('id') id: string,
    @Body() body: AdminCreateStudentDto,
    @Req() req: Request & { adminPrincipal?: AdminPrincipal },
  ): Promise<AdminCreateStudentResponseDto> {
    const principal = req.adminPrincipal!;
    return this.members.createStudentForMember({
      memberId: id,
      displayName: body.displayName,
      birthDate: body.birthDate,
      relationType: body.relationType,
      verifiedByAdminId: principal.adminUserId,
    });
  }

  // ── Students (profile edits + relation management) ─────────────────────

  @Patch('students/:studentId')
  @HttpCode(HttpStatus.OK)
  async updateStudent(
    @Param('studentId') studentId: string,
    @Body() body: AdminUpdateStudentDto,
  ): Promise<AdminUpdateStudentResponseDto> {
    return this.students.update({
      studentId,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.birthDate !== undefined ? { birthDate: body.birthDate } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
  }

  @Post('students/:studentId/relations')
  @HttpCode(HttpStatus.CREATED)
  async linkRelation(
    @Param('studentId') studentId: string,
    @Body() body: AdminLinkRelationDto,
    @Req() req: Request & { adminPrincipal?: AdminPrincipal },
  ): Promise<AdminLinkRelationResponseDto> {
    const principal = req.adminPrincipal!;
    return this.relations.linkGuardian({
      studentId,
      accountId: body.accountId,
      relationType: body.relationType as RelationType,
      verifiedByAdminId: principal.adminUserId,
    });
  }

  @Delete('students/:studentId/relations/:accountId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkRelation(
    @Param('studentId') studentId: string,
    @Param('accountId') accountId: string,
  ): Promise<void> {
    await this.relations.unlinkGuardian({ studentId, accountId });
  }
}
