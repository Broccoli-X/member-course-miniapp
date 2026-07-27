/**
 * Admin member/student/relation API client.
 *
 * Wraps the Task 6 endpoints:
 *   - GET    /api/admin/v1/members
 *   - POST   /api/admin/v1/members
 *   - GET    /api/admin/v1/members/:id
 *   - POST   /api/admin/v1/members/:id/students
 *   - PATCH  /api/admin/v1/students/:studentId
 *   - POST   /api/admin/v1/students/:studentId/relations
 *   - DELETE /api/admin/v1/students/:studentId/relations/:accountId
 */
import { http } from './http';
import type { PaginatedResult } from '@member-course/contracts';
import type {
  MemberAccountView,
  MemberDetailView,
  CreateMemberRequest,
  AdminCreateStudentRequest,
  AdminUpdateStudentRequest,
  AdminLinkRelationRequest,
  CreateStudentResult,
  StudentProfileView,
  AccountStudentRelationView,
} from '@member-course/contracts';

export interface ListMembersParams {
  page?: number;
  pageSize?: number;
  phone?: string;
}

export const membersApi = {
  listMembers(params: ListMembersParams = {}): Promise<PaginatedResult<MemberAccountView>> {
    return http.get<PaginatedResult<MemberAccountView>>('/admin/v1/members', {
      query: { page: params.page, pageSize: params.pageSize, phone: params.phone },
    });
  },
  createMember(body: CreateMemberRequest): Promise<MemberAccountView> {
    return http.post<MemberAccountView>('/admin/v1/members', body);
  },
  getMember(id: string): Promise<MemberDetailView> {
    return http.get<MemberDetailView>(`/admin/v1/members/${id}`);
  },
  createStudent(memberId: string, body: AdminCreateStudentRequest): Promise<CreateStudentResult> {
    return http.post<CreateStudentResult>(`/admin/v1/members/${memberId}/students`, body);
  },
  updateStudent(studentId: string, body: AdminUpdateStudentRequest): Promise<StudentProfileView> {
    return http.patch<StudentProfileView>(`/admin/v1/students/${studentId}`, body);
  },
  linkRelation(studentId: string, body: AdminLinkRelationRequest): Promise<AccountStudentRelationView> {
    return http.post<AccountStudentRelationView>(`/admin/v1/students/${studentId}/relations`, body);
  },
  unlinkRelation(studentId: string, accountId: string): Promise<void> {
    return http.delete<void>(`/admin/v1/students/${studentId}/relations/${accountId}`);
  },
};

export default membersApi;
