import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import OrderCreateView from './OrderCreateView.vue';

const memberFixture = {
  items: [
    { id: 'mem-1', normalizedPhone: '13800000001', status: 'ACTIVE', isProvisional: false, version: 1 },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

const memberDetailFixture = {
  account: { id: 'mem-1', normalizedPhone: '13800000001', status: 'ACTIVE', isProvisional: false, version: 1 },
  students: [
    {
      id: 'stu-1',
      displayName: '小王',
      birthDate: null,
      status: 'ACTIVE',
      version: 1,
      relation: { id: 'rel-1', accountId: 'mem-1', studentId: 'stu-1', relationType: 'GUARDIAN', verifiedByAdminId: 'admin-1', version: 1 },
    },
  ],
};

const createdOrder = {
  id: 'ord-new',
  buyerAccountId: 'mem-1',
  status: 'PENDING',
  totalAmount: '1000.00',
  confirmedAt: null,
  items: [],
  version: 1,
};

vi.mock('../../api/members', () => ({
  default: {
    listMembers: vi.fn(async () => memberFixture),
    getMember: vi.fn(async () => memberDetailFixture),
  },
}));

vi.mock('../../api/orders', () => ({
  default: { createOrder: vi.fn(async () => createdOrder) },
}));

const ordersApi = (await import('../../api/orders')).default;

function mountCreate() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: OrderCreateView },
      { path: '/orders/:id', name: 'order-detail', component: { template: '<div />' } },
    ],
  });
  const wrapper = mount(OrderCreateView, { global: { plugins: [router] } });
  return { wrapper, router };
}

describe('OrderCreateView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('creates a draft with buyer + one item and navigates to detail', async () => {
    const { wrapper, router } = mountCreate();
    await flushPromises();

    // Select buyer (el-select — drive via emitted model update + change).
    const buyerSelect = wrapper.findAllComponents({ name: 'ElSelect' })[0];
    await buyerSelect.vm.$emit('update:modelValue', 'mem-1');
    await buyerSelect.vm.$emit('change', 'mem-1');
    await flushPromises();
    // Add an item: student + product.
    const studentSelect = wrapper.findAllComponents({ name: 'ElSelect' })[1];
    await studentSelect.vm.$emit('update:modelValue', 'stu-1');
    await studentSelect.vm.$emit('change', 'stu-1');
    await wrapper.get('[name="productId"]').setValue('pkg-1');
    await wrapper.get('[data-testid="add-item"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="submit-order"]').trigger('click');
    await flushPromises();

    expect(ordersApi.createOrder).toHaveBeenCalledWith({
      buyerAccountId: 'mem-1',
      items: [{ studentId: 'stu-1', productId: 'pkg-1' }],
    });
    expect(router.currentRoute.value.name).toBe('order-detail');
    expect(router.currentRoute.value.params.id).toBe('ord-new');
  });

  it('does not submit without a buyer', async () => {
    const { wrapper } = mountCreate();
    await flushPromises();
    await wrapper.get('[data-testid="submit-order"]').trigger('click');
    await flushPromises();
    expect(ordersApi.createOrder).not.toHaveBeenCalled();
  });
});
