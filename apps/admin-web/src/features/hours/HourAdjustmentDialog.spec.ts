import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import HourAdjustmentDialog from './HourAdjustmentDialog.vue';

vi.mock('../../api/hours', () => ({
  default: {
    grantHours: vi.fn(async () => ({
      transactionId: 'tx-1',
      balanceId: 'bal-1',
      allocations: [],
      balance: { available: '1.50', reserved: '0.00', consumed: '0.00', expired: '0.00' },
    })),
    debitHours: vi.fn(async () => ({
      transactionId: 'tx-2',
      balanceId: 'bal-1',
      allocations: [],
      balance: { available: '0.00', reserved: '0.00', consumed: '0.00', expired: '0.00' },
    })),
  },
}));

const api = (await import('../../api/hours')).default;

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(HourAdjustmentDialog, {
    props: {
      studentId: 'stu-1',
      courseId: 'c1',
      ...props,
    },
  });
}

describe('HourAdjustmentDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  // ── Verbatim decimal + reason case ─────────────────────────────────────────
  it('requires a reason and preserves decimal text', async () => {
    const wrapper = mountDialog();
    // Switch to the GRANT mode so startsOn/expiresOn are involved too.
    await wrapper.get('[data-testid="mode-grant"]').trigger('click');
    await wrapper.get('[name="startsOn"]').setValue('2026-07-24');
    await wrapper.get('[name="expiresOn"]').setValue('2026-12-31');

    const unitsInput = wrapper.get('[name="units"]');
    const reasonInput = wrapper.get('[name="reason"]');
    const submit = wrapper.get('[data-testid="hour-submit"]');

    // units present but reason empty -> submit must NOT call grantHours.
    await unitsInput.setValue('1.50');
    await submit.trigger('click');
    await flushPromises();
    expect(api.grantHours).not.toHaveBeenCalled();

    // reason filled -> submit calls grantHours with units preserved as '1.50'.
    await reasonInput.setValue('补课');
    await submit.trigger('click');
    await flushPromises();
    expect(api.grantHours).toHaveBeenCalledWith(
      'stu-1',
      'c1',
      expect.objectContaining({ units: '1.50', reason: '补课' }),
    );
    // units stayed a string end-to-end.
    const call = vi.mocked(api.grantHours).mock.calls[0];
    expect(typeof call[2].units).toBe('string');
    expect(call[2].units).toBe('1.50');
  });

  it('debits with a reason and preserves decimal units as a string', async () => {
    const wrapper = mountDialog();
    await wrapper.get('[data-testid="mode-debit"]').trigger('click');
    await wrapper.get('[name="units"]').setValue('2.50');
    await wrapper.get('[name="reason"]').setValue('请假扣减');
    await wrapper.get('[data-testid="hour-submit"]').trigger('click');
    await flushPromises();
    expect(api.debitHours).toHaveBeenCalledWith(
      'stu-1',
      'c1',
      expect.objectContaining({ units: '2.50', reason: '请假扣减' }),
    );
  });

  it('does not debit when the reason is blank', async () => {
    const wrapper = mountDialog();
    await wrapper.get('[data-testid="mode-debit"]').trigger('click');
    await wrapper.get('[name="units"]').setValue('2.50');
    await wrapper.get('[data-testid="hour-submit"]').trigger('click');
    await flushPromises();
    expect(api.debitHours).not.toHaveBeenCalled();
  });

  it('emits submitted after a successful grant so the parent can refresh', async () => {
    const wrapper = mountDialog();
    await wrapper.get('[data-testid="mode-grant"]').trigger('click');
    await wrapper.get('[name="startsOn"]').setValue('2026-07-24');
    await wrapper.get('[name="expiresOn"]').setValue('2026-12-31');
    await wrapper.get('[name="units"]').setValue('1.50');
    await wrapper.get('[name="reason"]').setValue('补课');
    await wrapper.get('[data-testid="hour-submit"]').trigger('click');
    await flushPromises();
    expect(wrapper.emitted('submitted')).toBeTruthy();
  });
});
