import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import CourseListView from './CourseListView.vue';

const coursesFixture = {
  items: [
    { id: 'c1', name: '少儿英语', type: 'CLASS', description: '启蒙', status: 'ACTIVE', version: 1 },
    { id: 'c2', name: '钢琴一对一', type: 'ONE_TO_ONE', description: '', status: 'ACTIVE', version: 1 },
  ],
  total: 2,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

const archivedCourse = {
  id: 'c1',
  name: '少儿英语',
  type: 'CLASS',
  description: '启蒙',
  status: 'ARCHIVED',
  version: 2,
};

vi.mock('../../api/catalog', () => ({
  default: {
    listCourses: vi.fn(async () => coursesFixture),
    createCourse: vi.fn(),
    updateCourse: vi.fn(),
    archiveCourse: vi.fn(async () => archivedCourse),
  },
}));

const api = (await import('../../api/catalog')).default;

function mountList() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: CourseListView },
      { path: '/courses/:id', name: 'course-edit', component: { template: '<div />' } },
    ],
  });
  const wrapper = mount(CourseListView, { global: { plugins: [router] } });
  return { wrapper, router };
}

describe('CourseListView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('loads and renders courses on mount', async () => {
    const { wrapper } = mountList();
    await flushPromises();
    expect(api.listCourses).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
    expect(wrapper.text()).toContain('少儿英语');
    expect(wrapper.text()).toContain('钢琴一对一');
  });

  it('navigates to the edit route on row click', async () => {
    const { wrapper, router } = mountList();
    await flushPromises();
    await wrapper.get('[data-testid="course-row-c1"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('course-edit');
    expect(router.currentRoute.value.params.id).toBe('c1');
  });

  it('asks for confirmation before archiving a course', async () => {
    const { wrapper } = mountList();
    await flushPromises();
    // jsdom has no native confirm; stub window.confirm to accept.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await wrapper.get('[data-testid="archive-course-c1"]').trigger('click');
    await flushPromises();
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.archiveCourse).toHaveBeenCalledWith('c1');
    confirmSpy.mockRestore();
  });
});
