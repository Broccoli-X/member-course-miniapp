import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import HourLedgerTable from './HourLedgerTable.vue';

const balancesFixture = {
  items: [
    {
      id: 'bal-1',
      studentId: 'stu-1',
      courseId: 'c1',
      available: '10.00',
      reserved: '0.00',
      consumed: '2.00',
      expired: '0.00',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

const packagesFixture = {
  items: [
    {
      id: 'pkg-1',
      studentId: 'stu-1',
      courseId: 'c1',
      sourceType: 'ORDER',
      status: 'ACTIVE',
      startsOn: '2026-07-24',
      expiresOn: '2027-01-20',
      granted: '12.00',
      available: '10.00',
      reserved: '0.00',
      consumed: '2.00',
      expired: '0.00',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

const transactionsFixture = {
  items: [
    {
      id: 'tx-1',
      studentId: 'stu-1',
      courseId: 'c1',
      type: 'GRANT',
      businessKey: 'order-grant:item-1',
      originalTransactionId: null,
      availableDelta: '12.00',
      reservedDelta: '0.00',
      consumedDelta: '0.00',
      expiredDelta: '0.00',
      reason: null,
      occurredAt: '2026-07-24T08:00:00.000Z',
      allocations: [],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

vi.mock('../../api/hours', () => ({
  default: {
    listBalances: vi.fn(async () => balancesFixture),
    listPackages: vi.fn(async () => packagesFixture),
    listTransactions: vi.fn(async () => transactionsFixture),
  },
}));

const api = (await import('../../api/hours')).default;

function mountTable(props: Record<string, unknown> = {}) {
  return mount(HourLedgerTable, {
    props: { studentId: 'stu-1', ...props },
  });
}

describe('HourLedgerTable', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('loads balances, packages, and transactions on mount', async () => {
    mountTable();
    await flushPromises();
    expect(api.listBalances).toHaveBeenCalledWith('stu-1', { page: 1, pageSize: 20 });
    expect(api.listPackages).toHaveBeenCalledWith('stu-1', { page: 1, pageSize: 20 });
    expect(api.listTransactions).toHaveBeenCalledWith('stu-1', { page: 1, pageSize: 20 });
  });

  it('renders decimal balances and deltas as strings', async () => {
    const wrapper = mountTable();
    await flushPromises();
    const text = wrapper.text();
    // Balance buckets rendered verbatim.
    expect(text).toContain('10.00');
    expect(text).toContain('2.00');
    expect(text).toContain('12.00');
  });

  it('reloads all panels when refresh is invoked', async () => {
    const wrapper = mountTable();
    await flushPromises();
    expect(api.listBalances).toHaveBeenCalledTimes(1);
    expect(api.listPackages).toHaveBeenCalledTimes(1);
    expect(api.listTransactions).toHaveBeenCalledTimes(1);

    // Public refresh hook (used by the parent after an adjustment command).
    await wrapper.vm.refresh();
    await flushPromises();
    expect(api.listBalances).toHaveBeenCalledTimes(2);
    expect(api.listPackages).toHaveBeenCalledTimes(2);
    expect(api.listTransactions).toHaveBeenCalledTimes(2);
  });
});
