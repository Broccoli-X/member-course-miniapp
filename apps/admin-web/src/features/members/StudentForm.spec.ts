import { describe, it, expect } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import StudentForm from './StudentForm.vue';

function mountForm(props: Record<string, unknown> = {}) {
  const wrapper = mount(StudentForm, { props: { ...props } });
  return wrapper;
}

describe('StudentForm', () => {
  it('emits submit with displayName, relationType and optional birthDate', async () => {
    const wrapper = mountForm();
    await wrapper.get('input[name="displayName"]').setValue('小陈');
    await wrapper.get('input[name="birthDate"]').setValue('2020-05-01');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const emitted = wrapper.emitted('submit');
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toEqual(
      expect.objectContaining({ displayName: '小陈', birthDate: '2020-05-01' }),
    );
  });

  it('requires a displayName before submitting', async () => {
    const wrapper = mountForm();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.emitted('submit')).toBeFalsy();
  });

  it('defaults relationType to GUARDIAN', async () => {
    const wrapper = mountForm();
    await wrapper.get('input[name="displayName"]').setValue('小陈');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const payload = wrapper.emitted('submit')![0][0] as { relationType: string };
    expect(payload.relationType).toBe('GUARDIAN');
  });
});
