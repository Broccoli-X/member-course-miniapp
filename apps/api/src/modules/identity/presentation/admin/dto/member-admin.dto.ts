import {
  type AccountStudentRelationView,
  type AdminCreateStudentRequest,
  type AdminLinkRelationRequest,
  type AdminUpdateStudentRequest,
  type CreateMemberRequest,
  type CreateStudentResult,
  type MemberAccountView,
  type MemberDetailView,
  type RelationType,
  type StudentProfileView,
  type StudentStatus,
} from '@member-course/contracts';
import type { PaginatedResult } from '@member-course/contracts';

/**
 * Plain DTOs for the admin member/student endpoints. Mirrors the
 * {@link member} contracts; kept as classes for future class-validator
 * wiring. Validation is intentionally minimal (no global ValidationPipe is
 * registered — see task-4-brief.md).
 */

export class CreateMemberDto implements CreateMemberRequest {
  normalizedPhone!: string;
  status?: 'ACTIVE' | 'SUSPENDED';
}

export type CreateMemberResponseDto = MemberAccountView;

export class AdminCreateStudentDto implements AdminCreateStudentRequest {
  displayName!: string;
  birthDate?: string | null;
  relationType!: RelationType;
}

export type AdminCreateStudentResponseDto = CreateStudentResult;

export class AdminUpdateStudentDto implements AdminUpdateStudentRequest {
  displayName?: string;
  birthDate?: string | null;
  status?: StudentStatus;
}

export type AdminUpdateStudentResponseDto = StudentProfileView;

export class AdminLinkRelationDto implements AdminLinkRelationRequest {
  accountId!: string;
  relationType!: RelationType;
}

export type AdminLinkRelationResponseDto = AccountStudentRelationView;

export type AdminMemberDetailResponseDto = MemberDetailView;

export type AdminMemberListResponseDto = PaginatedResult<MemberAccountView>;
