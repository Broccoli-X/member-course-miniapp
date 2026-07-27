import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import OrderListView from './OrderListView.vue';

const ordersFixture = {
  items: [
    {
      id: 'ord-1',
      buyerAccountId: 'mem-1',
      status: 'PENDING',
      totalAmount: '1000.00',
      confirmedAt: null,
      items: [],
      version: 1,
    },
    {
      id: 'ord-2',
      buyerAccountId: 'mem-2',
      status: 'CONFIRMED',
      totalAmount: '2000.00',
      confirmedAt: '2026-07-24T08:00:00.000Z',
      items: [],
      version: 3,
    },
  ],
  total: 2,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

vi.mock('../../api/orders', () => ({
  default: { listOrders: vi.fn(async () => ordersFixture) },
}));

const api = (await import('../../api/orders')).default;

function mountList() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: OrderListView },
      { path: '/orders/:id', name: 'order-detail', component: { template: '<div />' } },
      { path: '/orders/create', name: 'order-create', component: { template: '<div />' } },
    ],
  });
  const wrapper = mount(OrderListView, { global: { plugins: [router] } });
  return { wrapper, router };
}

describe('OrderListView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('loads and renders orders on mount with decimal totals preserved', async () => {
    const { wrapper } = mountList();
    await flushPromises();
    expect(api.listOrders).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
    expect(wrapper.text()).toContain('ord-1');
    expect(wrapper.text()).toContain('1000.00');
    expect(wrapper.text()).toContain('2000.00');
  });

  it('filters by status when the filter changes', async () => {
    const { wrapper } = mountList();
    await flushPromises();
    // Element Plus el-select renders as a div (setValue won't work); emit the
    // model update + change directly on the component instance.
    const select = wrapper.findComponent({ name: 'ElSelect' });
    await select.vm.$emit('update:modelValue', 'CONFIRMED');
    await select.vm.$emit('change', 'CONFIRMED');
    await flushPromises();
    expect(api.listOrders).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, status: 'CONFIRMED' }),
    );
  });

  it('navigates to create on the new-order button', async () => {
    const { wrapper, router } = mountList();
    await flushPromises();
    await wrapper.get('[data-testid="create-order"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('order-create');
  });

  it('opens the order detail on the detail button', async () => {
    const { wrapper, router } = mountList();
    await flushPromises();
    await wrapper.get('[data-testid="open-order-ord-1"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('order-detail');
    expect(router.currentRoute.value.params.id).toBe('ord-1');
  });
});
