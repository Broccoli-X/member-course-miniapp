/**
 * Admin catalog (course + package product) API client.
 *
 * Wraps the Task 7 endpoints:
 *   - GET    /api/admin/v1/courses
 *   - POST   /api/admin/v1/courses
 *   - PATCH  /api/admin/v1/courses/:id
 *   - POST   /api/admin/v1/courses/:id/archive
 *   - POST   /api/admin/v1/courses/:courseId/package-products
 *   - PATCH  /api/admin/v1/package-products/:id
 *   - POST   /api/admin/v1/package-products/:id/archive
 *
 * Money (price) and lesson quantity (hours) are decimal strings on the wire —
 * they are passed through unchanged (never coerced to JS number).
 */
import { http, ApiError } from './http';
import type { PaginatedResult } from '@member-course/contracts';
import type {
  CourseView,
  PackageProductView,
  CreateCourseRequest,
  UpdateCourseRequest,
  CreatePackageProductRequest,
  UpdatePackageProductRequest,
} from '@member-course/contracts';

export interface ListCoursesParams {
  page?: number;
  pageSize?: number;
  status?: string;
  type?: string;
}

export const catalogApi = {
  listCourses(params: ListCoursesParams = {}): Promise<PaginatedResult<CourseView>> {
    return http.get<PaginatedResult<CourseView>>('/admin/v1/courses', {
      query: {
        page: params.page,
        pageSize: params.pageSize,
        status: params.status,
        type: params.type,
      },
    });
  },
  /**
   * Fetch a single course. The admin catalog has no dedicated `GET
   * /courses/:id` endpoint in M1, so this loads the (small) first page of the
   * list and finds the matching row. M2 will add a direct lookup endpoint.
   */
  async getCourse(id: string): Promise<CourseView> {
    const result = await this.listCourses({ page: 1, pageSize: 200 });
    const found = result.items.find((c) => c.id === id);
    if (!found) {
      throw new ApiError('RESOURCE_NOT_FOUND', '课程不存在', 'unknown', 404);
    }
    return found;
  },
  createCourse(body: CreateCourseRequest): Promise<CourseView> {
    return http.post<CourseView>('/admin/v1/courses', body);
  },
  updateCourse(id: string, body: UpdateCourseRequest): Promise<CourseView> {
    return http.patch<CourseView>(`/admin/v1/courses/${id}`, body);
  },
  archiveCourse(id: string): Promise<CourseView> {
    return http.post<CourseView>(`/admin/v1/courses/${id}/archive`);
  },
  createPackageProduct(courseId: string, body: CreatePackageProductRequest): Promise<PackageProductView> {
    return http.post<PackageProductView>(`/admin/v1/courses/${courseId}/package-products`, body);
  },
  updatePackageProduct(id: string, body: UpdatePackageProductRequest): Promise<PackageProductView> {
    return http.patch<PackageProductView>(`/admin/v1/package-products/${id}`, body);
  },
  archivePackageProduct(id: string): Promise<PackageProductView> {
    return http.post<PackageProductView>(`/admin/v1/package-products/${id}/archive`);
  },
};

export default catalogApi;
