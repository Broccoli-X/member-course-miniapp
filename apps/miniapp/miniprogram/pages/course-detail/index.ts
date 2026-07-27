import { publicRequest, ApiError } from '../../services/http';

interface CoursePackage {
  id: string;
  courseId: string;
  name: string;
  /** Decimal string — never coerced through JS number math. */
  price: string;
  /** Decimal string — never coerced through JS number math. */
  hours: string;
  validDays: number;
}

interface Course {
  id: string;
  name: string;
  type: string;
  description: string;
}

interface CourseDetailResponse {
  course: Course;
  packages: CoursePackage[];
}

interface PageData {
  course: Course | null;
  packages: CoursePackage[];
  notFound: boolean;
  loading: boolean;
}

interface PageInstance extends PageData {
  setData(data: Partial<PageData>): void;
}

/**
 * Public course-detail page. Loads `GET /api/mini/v1/courses/:id` WITHOUT a
 * session — visitors may browse the catalog before binding a phone. Renders the
 * course and its purchasable packages; prices/hours are kept as decimal
 * strings so no JS floating-point math is performed client-side. A 404 lands
 * on a real "course unavailable" empty state.
 */
Page({
  data: {
    course: null,
    packages: [] as CoursePackage[],
    notFound: false,
    loading: false,
  },

  async onLoad(this: PageInstance, options: { id?: string } | undefined) {
    const id = options?.id;
    if (!id) {
      this.setData({ notFound: true });
      return;
    }
    this.setData({ loading: true });
    try {
      const result = await publicRequest<CourseDetailResponse>({
        path: `/api/mini/v1/courses/${id}`,
      });
      this.setData({
        course: result.course,
        packages: result.packages ?? [],
        notFound: false,
      });
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        this.setData({ notFound: true, course: null, packages: [] });
      } else {
        wx.showToast({
          title: err instanceof ApiError ? err.message : '加载课程失败',
          icon: 'none',
        });
      }
    } finally {
      this.setData({ loading: false });
    }
  },
});
