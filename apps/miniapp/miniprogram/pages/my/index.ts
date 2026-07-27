import {
  listBalances,
  type CourseBalanceView,
} from '../../services/assets';
import { ApiError, isRedirectedError, request } from '../../services/http';
import { currentStudentStore } from '../../stores/current-student-store';
import { sessionStore } from '../../stores/session-store';

interface MemberStudentView {
  student: { id: string; displayName: string };
  relation: { id: string; relationType: string };
}

interface PageData {
  isLoggedIn: boolean;
  students: Array<{ id: string; displayName: string }>;
  currentStudentId: string | null;
  balances: CourseBalanceView[];
  loading: boolean;
}

interface PageInstance extends PageData {
  data: PageData;
  setData(data: Partial<PageData>): void;
  loadBalances(): Promise<void>;
}

const PAGE_SIZE = 20;

/**
 * "我的" tab. Now that onboarding is done, the tab is the member's READ-ONLY
 * asset hub: it embeds the student-switcher, shows the active student's course
 * balances (the four 2-dp decimal-string buckets), and offers tappable entries
 * to orders / packages / hour-transactions. No payment/refund/booking/activity
 * actions are exposed in M1.
 */
Page({
  data: {
    isLoggedIn: false,
    students: [] as PageData['students'],
    currentStudentId: null,
    balances: [] as CourseBalanceView[],
    loading: false,
  },

  async onShow(this: PageInstance) {
    const isLoggedIn = sessionStore.isBound();
    this.setData({ isLoggedIn });
    if (!isLoggedIn) return;

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
      this.setData({ students, currentStudentId: currentStudentStore.currentId });
    } catch (err) {
      if (!isRedirectedError(err)) {
        const message = err instanceof ApiError ? err.message : '加载学员失败';
        wx.showToast({ title: message, icon: 'none' });
      }
      this.setData({ students: [], currentStudentId: null });
      return;
    }

    await this.loadBalances();
  },

  async loadBalances(this: PageInstance) {
    const id = currentStudentStore.currentId;
    if (!id) {
      this.setData({ balances: [] });
      return;
    }
    this.setData({ balances: [], loading: true });
    try {
      const result = await listBalances(id, { page: 1, pageSize: PAGE_SIZE });
      this.setData({ balances: result.items ?? [] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STUDENT_FORBIDDEN') {
        this.setData({ balances: [] });
        wx.showToast({ title: '无法查看该学员余额', icon: 'none' });
      } else if (!isRedirectedError(err)) {
        const message = err instanceof ApiError ? err.message : '加载余额失败';
        wx.showToast({ title: message, icon: 'none' });
        this.setData({ balances: [] });
      } else {
        this.setData({ balances: [] });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  /** Wired to the student-switcher's bind:change. */
  async onStudentChange(
    this: PageInstance,
    e: { detail: { id: string } },
  ) {
    const id = e.detail.id;
    if (id === this.data.currentStudentId) return;
    currentStudentStore.select(id);
    this.setData({ currentStudentId: id });
    await this.loadBalances();
  },

  onOpenOrders() {
    wx.navigateTo({ url: '/pages/orders/index' });
  },

  onOpenPackages() {
    wx.navigateTo({ url: '/pages/packages/index' });
  },

  onOpenHourTransactions() {
    wx.navigateTo({ url: '/pages/hour-transactions/index' });
  },
});
