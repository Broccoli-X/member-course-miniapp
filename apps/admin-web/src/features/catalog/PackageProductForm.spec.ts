import { describe, it, expect } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import PackageProductForm from './PackageProductForm.vue';

const pkg = {
  id: 'p1',
  courseId: 'c1',
  name: '10课时包',
  price: '1000.00',
  hours: '10.00',
  validDays: 180,
  status: 'ACTIVE',
  version: 1,
};

function mountForm(props: Record<string, unknown> = {}) {
  return mount(PackageProductForm, { props: { ...props } });
}

describe('PackageProductForm', () => {
  it('creates a package keeping price and hours as decimal strings', async () => {
    const wrapper = mountForm();
    await wrapper.get('[name="name"]').setValue('10课时包');
    await wrapper.get('[name="price"]').setValue('1000.00');
    await wrapper.get('[name="hours"]').setValue('10.00');
    await wrapper.get('[name="validDays"]').setValue('180');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const emitted = wrapper.emitted('submit');
    expect(emitted).toBeTruthy();
    const payload = emitted![0][0] as Record<string, unknown>;
    // Money and hours stay as strings on the wire — never converted to number.
    expect(payload.price).toBe('1000.00');
    expect(payload.hours).toBe('10.00');
    expect(payload.validDays).toBe(180);
    expect(payload.name).toBe('10课时包');
  });

  it('requires name, positive price, positive hours and positive validDays', async () => {
    const wrapper = mountForm();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.emitted('submit')).toBeFalsy();

    // Even with a name, a zero hours field is invalid.
    await wrapper.get('[name="name"]').setValue('x');
    await wrapper.get('[name="price"]').setValue('0');
    await wrapper.get('[name="hours"]').setValue('0');
    await wrapper.get('[name="validDays"]').setValue('0');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.emitted('submit')).toBeFalsy();
  });

  it('edits an existing package and preserves decimal strings from the server', async () => {
    const wrapper = mountForm({ package: pkg });
    // Existing price/hours are shown as-is (strings).
    expect((wrapper.get('[name="price"]').element as HTMLInputElement).value).toBe('1000.00');
    expect((wrapper.get('[name="hours"]').element as HTMLInputElement).value).toBe('10.00');
    await wrapper.get('[name="name"]').setValue('20课时包');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const payload = wrapper.emitted('submit')![0][0] as Record<string, unknown>;
    expect(payload.name).toBe('20课时包');
    expect(payload.price).toBe('1000.00');
    expect(typeof payload.price).toBe('string');
  });
});
