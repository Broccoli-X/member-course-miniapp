import { publicRequest, ApiError } from '../../services/http';

interface CatalogCourse {
  id: string;
  name: string;
  type: string;
  description: string;
}

interface PageData {
  courses: CatalogCourse[];
  loading: boolean;
}

interface PageInstance extends PageData {
  setData(data: Partial<PageData>): void;
}

/**
 * Public catalog landing page (tab 1). Loads `GET /api/mini/v1/courses` WITHOUT
 * a session — visitors may browse before binding a phone. Real empty state; no
 * schedule/activity placeholders (those land in later milestones).
 */
Page({
  data: {
    courses: [] as CatalogCourse[],
    loading: false,
  },

  async onLoad(this: PageInstance) {
    this.setData({ loading: true });
    try {
      const result = await publicRequest<{ items: CatalogCourse[] }>({
        path: '/api/mini/v1/courses',
      });
      this.setData({ courses: result.items ?? [] });
    } catch (err) {
      wx.showToast({
        title: err instanceof ApiError ? err.message : '加载课程失败',
        icon: 'none',
      });
      this.setData({ courses: [] });
    } finally {
      this.setData({ loading: false });
    }
  },

  onOpenCourse(e: { currentTarget: { dataset: { id: string } } }) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/course-detail/index?id=${id}` });
  },
});
