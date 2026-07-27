import { request, ApiError, isRedirectedError } from '../../services/http';
import { currentStudentStore } from '../../stores/current-student-store';

interface MemberStudentView {
  student: { id: string; displayName: string; birthDate: string | null };
  relation: { id: string; relationType: string };
}

interface PageData {
  students: Array<{ id: string; displayName: string; birthDate: string | null }>;
  currentId: string | null;
  loading: boolean;
}

interface PageInstance extends PageData {
  setData(data: Partial<PageData>): void;
}

/**
 * Member's related-students list. Loads `GET /api/mini/v1/students`, lets the
 * member pick an active student (persisted via {@link currentStudentStore}),
 * and offers create/edit entries into student-edit.
 */
Page({
  data: {
    students: [] as PageData['students'],
    currentId: null,
    loading: false,
  },

  async onLoad(this: PageInstance) {
    this.setData({ loading: true });
    try {
      const result = await request<{ items: MemberStudentView[] }>({
        path: '/api/mini/v1/students',
      });
      const students = (result.items ?? []).map((entry) => ({
        id: entry.student.id,
        displayName: entry.student.displayName,
        birthDate: entry.student.birthDate,
      }));
      currentStudentStore.restore(
        students.map((s) => ({ id: s.id })),
        currentStudentStore.hydrate(),
      );
      this.setData({
        students,
        currentId: currentStudentStore.currentId,
      });
    } catch (err) {
      // If the http layer already redirected to login (session expired),
      // suppress the toast — it would race with the navigation.
      if (!isRedirectedError(err)) {
        const message = err instanceof ApiError ? err.message : '加载学员失败';
        wx.showToast({ title: message, icon: 'none' });
      }
      this.setData({ students: [] });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSelectStudent(
    this: PageInstance,
    e: { currentTarget: { dataset: { id: string } } },
  ) {
    currentStudentStore.select(e.currentTarget.dataset.id);
    this.setData({ currentId: currentStudentStore.currentId });
  },

  onAddStudent() {
    wx.navigateTo({ url: '/pages/student-edit/index' });
  },

  onEditStudent(
    this: PageInstance,
    e: { currentTarget: { dataset: { id: string } } },
  ) {
    wx.navigateTo({ url: `/pages/student-edit/index?id=${e.currentTarget.dataset.id}` });
  },
});
