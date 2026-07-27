import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import OrderDetailView from './OrderDetailView.vue';
import { ApiError } from '../../api/http';

const orderId = 'ord-1';

const pendingOrder = {
  id: orderId,
  buyerAccountId: 'mem-1',
  status: 'PENDING',
  totalAmount: '1000.00',
  confirmedAt: null,
  items: [
    {
      id: 'item-1',
      orderId,
      studentId: 'stu-1',
      productId: 'pkg-1',
      courseId: 'c1',
      productNameSnapshot: '10课时包',
      unitPriceSnapshot: '1000.00',
      hoursSnapshot: '10.00',
      validDaysSnapshot: 180,
      coursePackageId: null,
      grantTransactionId: null,
      version: 1,
    },
  ],
  version: 1,
};

const confirmedOrder = {
  ...pendingOrder,
  status: 'CONFIRMED',
  confirmedAt: '2026-07-24T08:00:00.000Z',
  version: 2,
};

vi.mock('../../api/orders', () => ({
  default: {
    getOrder: vi.fn(async () => pendingOrder),
    confirmOrder: vi.fn(async () => confirmedOrder),
    voidOrder: vi.fn(async () => ({ voided: true as const, orderId })),
    reverseOrder: vi.fn(async () => ({ ...confirmedOrder, status: 'REVERSED' })),
  },
}));

const api = (await import('../../api/orders')).default;

function mountDetail(initial?: typeof pendingOrder) {
  if (initial !== undefined) {
    vi.mocked(api.getOrder).mockResolvedValueOnce(initial);
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/:id', name: 'order-detail', component: OrderDetailView, props: true },
      { path: '/orders', name: 'orders', component: { template: '<div />' } },
    ],
  });
  router.push(`/${orderId}`);
  const wrapper = mount(OrderDetailView, { global: { plugins: [router] } });
  return { wrapper, router };
}

describe('OrderDetailView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('loads and renders the order with decimal totals preserved as strings', async () => {
    const { wrapper } = mountDetail();
    await flushPromises();
    expect(api.getOrder).toHaveBeenCalledWith(orderId);
    // totalAmount / unitPriceSnapshot / hoursSnapshot are rendered verbatim.
    expect(wrapper.text()).toContain('1000.00');
    expect(wrapper.text()).toContain('10.00');
  });

  // ── Verbatim idempotency case ──────────────────────────────────────────────
  it('uses one idempotency key for repeated confirm clicks', async () => {
    const { wrapper } = mountDetail();
    await flushPromises();

    const confirmButton = wrapper.get('[data-testid="confirm-order"]');
    await confirmButton.trigger('click');
    // Second click before the first settles — must NOT fire a second confirm.
    await confirmButton.trigger('click');
    await flushPromises();

    expect(api.confirmOrder).toHaveBeenCalledTimes(1);
    // Both calls (if any) must share the SAME idempotency key.
    const calls = vi.mocked(api.confirmOrder).mock.calls;
    if (calls.length >= 1) {
      const key = calls[0][1];
      expect(key).toBeTruthy();
      for (const c of calls) expect(c[1]).toBe(key);
    }
  });

  it('refreshes the order panel after a successful confirm', async () => {
    const { wrapper } = mountDetail();
    await flushPromises();
    // getOrder was called once on mount; after confirm it should be called again.
    expect(api.getOrder).toHaveBeenCalledTimes(1);
    await wrapper.get('[data-testid="confirm-order"]').trigger('click');
    await flushPromises();
    expect(api.getOrder).toHaveBeenCalledTimes(2);
  });

  it('voids a draft with one idempotency key and returns to the list', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { wrapper, router } = mountDetail();
    await flushPromises();

    await wrapper.get('[data-testid="void-order"]').trigger('click');
    await flushPromises();

    expect(confirmSpy).toHaveBeenCalled();
    expect(api.voidOrder).toHaveBeenCalledTimes(1);
    // A voided draft is physically removed → the view navigates back to the
    // list (no detail to reload). The idempotency key was supplied exactly once.
    const [, key] = vi.mocked(api.voidOrder).mock.calls[0];
    expect(key).toBeTruthy();
    expect(router.currentRoute.value.name).toBe('orders');
    confirmSpy.mockRestore();
  });

  it('requires a reason to reverse a confirmed order', async () => {
    vi.spyOn(window, 'prompt').mockReturnValueOnce(''); // empty reason -> abort
    const { wrapper } = mountDetail(confirmedOrder);
    await flushPromises();

    await wrapper.get('[data-testid="reverse-order"]').trigger('click');
    await flushPromises();

    expect(api.reverseOrder).not.toHaveBeenCalled();
  });

  it('reverses with a reason and refreshes', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('客户退费');
    const { wrapper } = mountDetail(confirmedOrder);
    await flushPromises();

    await wrapper.get('[data-testid="reverse-order"]').trigger('click');
    await flushPromises();

    expect(api.reverseOrder).toHaveBeenCalledWith(orderId, expect.objectContaining({ reason: '客户退费' }), expect.any(String));
    expect(api.getOrder).toHaveBeenCalledTimes(2);
  });

  it('shows a friendly message when a used order is not reversible', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('客户退费');
    vi.mocked(api.reverseOrder).mockRejectedValueOnce(
      new ApiError('ORDER_NOT_REVERSIBLE', '该课包已有消耗/调整记录', 'trace-1', 409),
    );
    const { wrapper } = mountDetail(confirmedOrder);
    await flushPromises();

    await wrapper.get('[data-testid="reverse-order"]').trigger('click');
    await flushPromises();

    // A reversal blocked by downstream activity surfaces a friendly explanation.
    expect(wrapper.text()).toContain('消耗');
  });

  it('disables confirm/edit actions on a confirmed order', async () => {
    const { wrapper } = mountDetail(confirmedOrder);
    await flushPromises();
    // Confirmed orders cannot be edited: the confirm button is gone/disabled.
    const confirmBtn = wrapper.find('[data-testid="confirm-order"]');
    expect(confirmBtn.exists() ? confirmBtn.attributes('disabled') : 'absent').toBeTruthy();
    const voidBtn = wrapper.find('[data-testid="void-order"]');
    expect(voidBtn.exists() ? voidBtn.attributes('disabled') : 'absent').toBeTruthy();
  });
});
