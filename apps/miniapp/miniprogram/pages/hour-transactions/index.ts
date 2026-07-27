import {
  listHourTransactions,
  type HourTransactionView,
} from '../../services/assets';
import { ApiError, isRedirectedError, request } from '../../services/http';
import { currentStudentStore } from '../../stores/current-student-store';

interface PageData {
  studentId: string | null;
  students: Array<{ id: string; displayName: string }>;
  transactions: HourTransactionView[];
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
 * The active student's hour-transaction history
 * (`GET /api/mini/v1/students/:studentId/hour-transactions`, newest first).
 * Private — server enforces `assertRelated` and returns 403
 * `STUDENT_FORBIDDEN` for an unrelated student.
 *
 * Same data-isolation contract as the packages page:
 *   - {@link loadStudent} clears `transactions` BEFORE the request.
 *   - 403 `STUDENT_FORBIDDEN` wipes the cache and toasts.
 *
 * Each row shows the type, the available delta (signed, 2-dp decimal string),
 * the occurred time, and the manual reason when present. Read-only — no
 * booking, payment, refund, or activity actions.
 */
Page({
  data: {
    studentId: null,
    students: [] as PageData['students'],
    transactions: [] as HourTransactionView[],
    loading: false,
  },

  async onShow(this: PageInstance) {
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

  async loadStudent(this: PageInstance, id: string) {
    this.setData({ studentId: id, transactions: [], loading: true });
    try {
      const result = await listHourTransactions(id, {
        page: 1,
        pageSize: PAGE_SIZE,
      });
      this.setData({ transactions: result.items ?? [] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STUDENT_FORBIDDEN') {
        this.setData({ transactions: [] });
        wx.showToast({ title: '无法查看该学员课时记录', icon: 'none' });
      } else if (!isRedirectedError(err)) {
        const message =
          err instanceof ApiError ? err.message : '加载课时记录失败';
        wx.showToast({ title: message, icon: 'none' });
        this.setData({ transactions: [] });
      } else {
        this.setData({ transactions: [] });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  async switchStudent(this: PageInstance, id: string) {
    if (id === this.data.studentId) return;
    currentStudentStore.select(id);
    await this.loadStudent(id);
  },

  async onStudentChange(
    this: PageInstance,
    e: { detail: { id: string } },
  ) {
    await this.switchStudent(e.detail.id);
  },
});
