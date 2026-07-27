import { listOrders, type MiniOrderView } from '../../services/assets';
import { ApiError, isRedirectedError } from '../../services/http';

interface PageData {
  orders: MiniOrderView[];
  loading: boolean;
  loadingMore: boolean;
  page: number;
  totalPages: number;
}

interface PageInstance extends PageData {
  data: PageData;
  setData(data: Partial<PageData>): void;
}

const PAGE_SIZE = 20;

/**
 * Paginated list of the member's OWN orders (`GET /api/mini/v1/orders`,
 * buyer-scoped server-side). Order rows expose the frozen item snapshots
 * (name/price/hours) captured at order time. Read-only — no payment, refund,
 * booking, or activity actions are exposed in M1.
 */
Page({
  data: {
    orders: [] as MiniOrderView[],
    loading: false,
    loadingMore: false,
    page: 1,
    totalPages: 1,
  },

  async onLoad(this: PageInstance) {
    this.setData({ loading: true, orders: [], page: 1 });
    try {
      const result = await listOrders({ page: 1, pageSize: PAGE_SIZE });
      this.setData({
        orders: result.items ?? [],
        page: result.page,
        totalPages: result.totalPages,
      });
    } catch (err) {
      if (!isRedirectedError(err)) {
        const message = err instanceof ApiError ? err.message : '加载订单失败';
        wx.showToast({ title: message, icon: 'none' });
      }
      this.setData({ orders: [], page: 1, totalPages: 1 });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onLoadMore(this: PageInstance) {
    const { page, totalPages, orders, loadingMore } = this.data;
    if (loadingMore || page >= totalPages) return;
    const nextPage = page + 1;
    this.setData({ loadingMore: true });
    try {
      const result = await listOrders({ page: nextPage, pageSize: PAGE_SIZE });
      const seen = new Set(orders.map((o) => o.id));
      const merged = [
        ...orders,
        ...(result.items ?? []).filter((o) => !seen.has(o.id)),
      ];
      this.setData({
        orders: merged,
        page: result.page,
        totalPages: result.totalPages,
      });
    } catch (err) {
      if (!isRedirectedError(err)) {
        const message = err instanceof ApiError ? err.message : '加载更多失败';
        wx.showToast({ title: message, icon: 'none' });
      }
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  onOpenOrder(
    this: PageInstance,
    e: { currentTarget: { dataset: { id: string } } },
  ) {
    wx.navigateTo({
      url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },
});
