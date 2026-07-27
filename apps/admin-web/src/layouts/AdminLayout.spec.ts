import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import AdminLayout from './AdminLayout.vue';
import { createAdminRouter } from '../router';
import { useAuthStore } from '../stores/auth';

describe('AdminLayout', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('redirects an unauthenticated administrator to login', async () => {
    const router = createAdminRouter(createMemoryHistory());
    const auth = useAuthStore();
    // Ensure no access token is present (unauthenticated).
    auth.accessToken = null;

    await router.push('/members');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('login');
  });

  it('renders the protected shell with all M1 navigation sections', async () => {
    const router = createAdminRouter(createMemoryHistory());
    const auth = useAuthStore();
    auth.accessToken = 'token';

    await router.push('/members');
    await router.isReady();

    const wrapper = mount(AdminLayout, {
      global: {
        plugins: [router],
        stubs: { RouterView: true },
      },
    });

    const navText = wrapper.find('[data-testid="admin-nav"]').text();
    expect(navText).toContain('会员学员');
    expect(navText).toContain('课程课包');
    // Task 13 adds offline orders + lesson-hour management navigation.
    expect(navText).toContain('线下订单');
    expect(navText).toContain('课时管理');
  });

  it('clears tokens and returns to login on logout', async () => {
    const router = createAdminRouter(createMemoryHistory());
    const auth = useAuthStore();
    auth.accessToken = 'token';
    auth.refreshToken = 'rt';

    await router.push('/members');
    await router.isReady();

    const wrapper = mount(AdminLayout, {
      global: {
        plugins: [router],
        stubs: { RouterView: true },
      },
    });

    await wrapper.get('[data-testid="logout"]').trigger('click');
    await router.isReady();
    // onLogout fires router.push({ name: 'login' }) without awaiting it, and
    // vue-router's guard queue settles across several microtasks under jsdom.
    // Drain those microtasks (flushPromises twice + a macrotask) so the
    // assertion sees the finalised route rather than relying on any
    // synchronous mutation of router internals.
    await flushPromises();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(auth.accessToken).toBeNull();
    expect(auth.refreshToken).toBeNull();
    expect(router.currentRoute.value.name).toBe('login');
  });
});
