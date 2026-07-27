import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import LoginView from './LoginView.vue';

vi.mock('../../api/auth', () => ({
  default: {
    login: vi.fn(async (body: { username: string; password: string }) => ({
      accessToken: 'at-' + body.username,
      refreshToken: 'rt-' + body.username,
      expiresIn: 900,
      admin: { id: 'admin-1', username: body.username },
    })),
    refresh: vi.fn(),
    logout: vi.fn(),
  },
}));

const api = (await import('../../api/auth')).default;

function mountLogin() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: LoginView },
      { path: '/members', name: 'members', component: { template: '<div />' } },
    ],
  });
  const wrapper = mount(LoginView, { global: { plugins: [router] } });
  return { wrapper, router };
}

describe('LoginView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('requires both username and password before submitting', async () => {
    const { wrapper } = mountLogin();
    // Submit without filling either field.
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(api.login).not.toHaveBeenCalled();
  });

  it('calls login and navigates to /members on success', async () => {
    const { wrapper, router } = mountLogin();
    await wrapper.get('[name="username"]').setValue('admin');
    await wrapper.get('[name="password"]').setValue('secret');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(api.login).toHaveBeenCalledWith({ username: 'admin', password: 'secret' });
    expect(router.currentRoute.value.name).toBe('members');
  });

  it('surfaces the API error message and traceId on failure', async () => {
    const { ApiError } = await import('../../api/http');
    const error = new ApiError('BAD_CREDENTIALS', '用户名或密码错误', 'trace-123', 401);
    api.login.mockRejectedValueOnce(error);
    const { wrapper } = mountLogin();

    await wrapper.get('[name="username"]').setValue('admin');
    await wrapper.get('[name="password"]').setValue('wrong');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const feedback = wrapper.find('[data-testid="login-error"]').text();
    expect(feedback).toContain('用户名或密码错误');
    expect(feedback).toContain('trace-123');
  });
});
