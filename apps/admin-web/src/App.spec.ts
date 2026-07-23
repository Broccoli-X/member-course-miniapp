import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import App from './App.vue';

describe('App', () => {
  it('renders the application shell', () => {
    const wrapper = mount(App, {
      global: {
        stubs: ['RouterView'],
      },
    });
    expect(wrapper.find('[data-testid="app-shell"]').exists()).toBe(true);
  });
});
