import {
  listPackages,
  type CoursePackageView,
} from '../../services/assets';
import { ApiError, isRedirectedError, request } from '../../services/http';
import { currentStudentStore } from '../../stores/current-student-store';

interface PageData {
  studentId: string | null;
  students: Array<{ id: string; displayName: string }>;
  packages: CoursePackageView[];
  loading: boolean;
}

interface PageInstance extends PageData {
  data: PageData;
  setData(data: Partial<PageData>): void;
  loadStudent(id: string): Promise<void>;
  switchStudent(id: string): Promise<void>;
}

const PAGE_SIZE = 20;

interface MemberStudentView {
  student: { id: string; displayName: string };
  relation: { id: string; relationType: string };
}

/**
 * The active student's course packages
 * (`GET /api/mini/v1/students/:studentId/course-packages`). Private — the
 * server enforces `assertRelated` and returns 403 `STUDENT_FORBIDDEN` when the
 * member is not related to the student.
 *
 * DATA ISOLATION CONTRACT (Task 15):
 *   - {@link loadStudent} clears `packages` BEFORE issuing the request, so a
 *     slow or failed load can never leave the previous student's packages on
 *     screen under the new student's heading.
 *   - A 403 `STUDENT_FORBIDDEN` clears `packages` and surfaces a toast; the
 *     cache is wiped so no stale data from a now-unrelated student remains.
 *
 * Effective (startsOn) and expiry (expiresOn) dates and the four buckets
 * (available/reserved/consumed/expired) are kept as 2-dp decimal strings.
 */
Page({
  data: {
    studentId: null,
    students: [] as PageData['students'],
    packages: [] as CoursePackageView[],
    loading: false,
  },

  async onShow(this: PageInstance) {
    // Refresh the related-students list (the member may have added/removed a
    // child since the last visit) so the switcher stays accurate.
    try {
      const result = await request<{ items: MemberStudentView[] }>({
        path: '/api/mini/v1/students',
      });
      const students = (result.items ?? []).map((entry) => ({
        id: entry.student.id,
        displayName: entry.student.displayName,
      }));
      currentStudentStore.restore(
        students.map((s) => ({ id: s.id })),
        currentStudentStore.currentId,
      );
      this.setData({ students });
    } catch (err) {
      if (!isRedirectedError(err)) {
        // Non-fatal: keep the existing switcher state if any.
      }
    }
    const id = currentStudentStore.currentId;
    if (id) await this.loadStudent(id);
  },

  /**
   * Load packages for `id`. Clears any previously-loaded packages FIRST so
   * there's no window where student A's packages show under student B.
   */
  async loadStudent(this: PageInstance, id: string) {
    this.setData({ studentId: id, packages: [], loading: true });
    try {
      const result = await listPackages(id, { page: 1, pageSize: PAGE_SIZE });
      this.setData({ packages: result.items ?? [] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STUDENT_FORBIDDEN') {
        // Member is no longer related to this student — wipe the cache so no
        // stale data from the now-unrelated student remains on screen.
        this.setData({ packages: [] });
        wx.showToast({ title: '无法查看该学员课时包', icon: 'none' });
      } else if (!isRedirectedError(err)) {
        const message = err instanceof ApiError ? err.message : '加载课时包失败';
        wx.showToast({ title: message, icon: 'none' });
        this.setData({ packages: [] });
      } else {
        this.setData({ packages: [] });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  /** Handler for the student-switcher `change` event. */
  async switchStudent(this: PageInstance, id: string) {
    if (id === this.data.studentId) return;
    currentStudentStore.select(id);
    await this.loadStudent(id);
  },

  /** Wired to the switcher's bind:change in the page wxml. */
  async onStudentChange(
    this: PageInstance,
    e: { detail: { id: string } },
  ) {
    await this.switchStudent(e.detail.id);
  },
});
