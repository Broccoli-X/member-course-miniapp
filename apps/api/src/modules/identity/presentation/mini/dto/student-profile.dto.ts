import {
  type CreateStudentResult,
  type MemberCreateStudentRequest,
  type MemberSelfServiceRelation,
  type MemberStudentView,
  type MemberUpdateStudentRequest,
} from '@member-course/contracts';

/**
 * Plain DTOs for the mini member/student endpoints. Mirrors the
 * {@link member} contracts; kept as classes for future class-validator
 * wiring. Validation is intentionally minimal.
 */

export class MemberCreateStudentDto implements MemberCreateStudentRequest {
  displayName!: string;
  birthDate?: string | null;
  relationship!: MemberSelfServiceRelation;
}

export type MemberCreateStudentResponseDto = CreateStudentResult;

export class MemberUpdateStudentDto implements MemberUpdateStudentRequest {
  displayName?: string;
  birthDate?: string | null;
}

export type MemberStudentResponseDto = MemberStudentView;
