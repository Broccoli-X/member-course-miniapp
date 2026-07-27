import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import MemberDetailView from './MemberDetailView.vue';

const memberId = 'mem-1';

const memberFixture = {
  account: { id: memberId, normalizedPhone: '13800000001', status: 'ACTIVE', isProvisional: false, version: 3 },
  students: [
    {
      id: 'stu-1',
      displayName: '小王',
      birthDate: null,
      status: 'ACTIVE',
      version: 1,
      relation: {
        id: 'rel-1',
        accountId: memberId,
        studentId: 'stu-1',
        relationType: 'GUARDIAN',
        verifiedByAdminId: 'admin-1',
        version: 1,
      },
    },
  ],
};

vi.mock('../../api/members', () => ({
  default: {
    getMember: vi.fn(async () => memberFixture),
    createStudent: vi.fn(async (_id: string, body: { displayName: string }) => ({
      student: {
        id: 'stu-new',
        displayName: body.displayName,
        birthDate: null,
        status: 'ACTIVE',
        version: 1,
      },
      relation: {
        id: 'rel-new',
        accountId: memberId,
        studentId: 'stu-new',
        relationType: 'GUARDIAN',
        verifiedByAdminId: 'admin-1',
        version: 1,
      },
    })),
    updateStudent: vi.fn(),
    linkRelation: vi.fn(),
    unlinkRelation: vi.fn(),
  },
}));

const api = (await import('../../api/members')).default;

function mountDetail() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:id', component: MemberDetailView, props: true }],
  });
  router.push(`/${memberId}`);
  const wrapper = mount(MemberDetailView, { global: { plugins: [router] } });
  return { wrapper, router };
}

describe('MemberDetailView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('loads the member and lists their students', async () => {
    const { wrapper } = mountDetail();
    await flushPromises();
    expect(api.getMember).toHaveBeenCalledWith(memberId);
    expect(wrapper.text()).toContain('13800000001');
    expect(wrapper.text()).toContain('小王');
  });

  it('pre-creates a child under the selected member', async () => {
    const { wrapper } = mountDetail();
    await flushPromises();

    await wrapper.get('[data-testid="add-student"]').trigger('click');
    await wrapper.get('[name="displayName"]').setValue('小陈');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(api.createStudent).toHaveBeenCalledWith(memberId, expect.objectContaining({ displayName: '小陈' }));
  });
});
