import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import CourseEditView from './CourseEditView.vue';

const courseId = 'c1';
const courseFixture = {
  id: courseId,
  name: '少儿英语',
  type: 'CLASS',
  description: '启蒙课程',
  status: 'ACTIVE',
  version: 1,
};

const updatedFixture = { ...courseFixture, name: '少儿英语进阶', version: 2 };

vi.mock('../../api/catalog', () => ({
  default: {
    getCourse: vi.fn(async () => courseFixture),
    createCourse: vi.fn(),
    updateCourse: vi.fn(async () => updatedFixture),
    listCourses: vi.fn(),
    archiveCourse: vi.fn(),
  },
}));

const api = (await import('../../api/catalog')).default;

function mountEdit(route = 'create') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/courses/create', name: 'course-create', component: CourseEditView },
      { path: '/courses/:id', name: 'course-edit', component: CourseEditView, props: true },
      { path: '/courses', name: 'courses', component: { template: '<div />' } },
    ],
  });
  if (route === 'create') {
    router.push('/courses/create');
  } else {
    router.push(`/courses/${courseId}`);
  }
  const wrapper = mount(CourseEditView, { global: { plugins: [router] } });
  return { wrapper, router };
}

describe('CourseEditView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('creates a course when no id is present in the route', async () => {
    api.createCourse = vi.fn(async () => courseFixture);
    const { wrapper } = mountEdit('create');
    await flushPromises();
    await wrapper.get('[name="name"]').setValue('少儿英语');
    await wrapper.get('[name="description"]').setValue('启蒙课程');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(api.createCourse).toHaveBeenCalledWith(
      expect.objectContaining({ name: '少儿英语', description: '启蒙课程', type: 'CLASS' }),
    );
  });

  it('loads an existing course and patches on save', async () => {
    const { wrapper } = mountEdit('edit');
    await flushPromises();
    expect(api.getCourse).toHaveBeenCalledWith(courseId);
    await wrapper.get('[name="name"]').setValue('少儿英语进阶');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(api.updateCourse).toHaveBeenCalledWith(courseId, expect.objectContaining({ name: '少儿英语进阶' }));
  });

  it('requires a name before submitting', async () => {
    const { wrapper } = mountEdit('create');
    await flushPromises();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(api.createCourse).not.toHaveBeenCalled();
  });
});
