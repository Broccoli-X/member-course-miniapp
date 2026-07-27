import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import MemberListView from './MemberListView.vue';

const membersFixture = {
  items: [
    { id: 'm1', normalizedPhone: '13800000001', status: 'ACTIVE', isProvisional: false, version: 1 },
    { id: 'm2', normalizedPhone: '13800000002', status: 'ACTIVE', isProvisional: false, version: 1 },
  ],
  total: 2,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

vi.mock('../../api/members', () => ({
  default: { listMembers: vi.fn(async () => membersFixture), createMember: vi.fn() },
}));

const api = (await import('../../api/members')).default;

function mountList() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: MemberListView }],
  });
  const wrapper = mount(MemberListView, { global: { plugins: [router] } });
  return { wrapper, router };
}

describe('MemberListView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('loads and renders members on mount', async () => {
    const { wrapper } = mountList();
    await flushPromises();
    expect(api.listMembers).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
    expect(wrapper.text()).toContain('13800000001');
    expect(wrapper.text()).toContain('13800000002');
  });

  it('searches by phone when the search field changes', async () => {
    const { wrapper } = mountList();
    await flushPromises();
    await wrapper.get('[name="phone"]').setValue('13800000001');
    await wrapper.get('[data-testid="member-search"]').trigger('click');
    await flushPromises();
    expect(api.listMembers).toHaveBeenCalledWith({ page: 1, pageSize: 20, phone: '13800000001' });
  });

  it('requests a new page when pagination changes', async () => {
    const { wrapper } = mountList();
    await flushPromises();
    await wrapper.get('[data-testid="next-page"]').trigger('click');
    await flushPromises();
    expect(api.listMembers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
  });
});
