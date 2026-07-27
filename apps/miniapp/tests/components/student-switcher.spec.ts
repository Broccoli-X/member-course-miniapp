import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// student-switcher component: a reusable picker for the active related student.
//
// Reads the related students + current selection (via its `students` and
// `currentId` properties) and renders a compact row the member can tap to
// change the active student. The pages hosting per-student assets (packages,
// hour-transactions, my) embed it; switching emits a `change` event the host
// page handles (so the page can clear assets + reload).
//
// NOTE on the test harness: the shared wx-mock captures the literal config
// passed to `Component({...})`. There's no full component runtime in Node, so
// property values are simulated by assigning onto `component.properties` and
// `component.data` before driving the lifecycle method — mirroring how WeChat
// resolves properties into `data` at attach time.
// ────────────────────────────────────────────────────────────────────────────

const STUDENTS = [
  { id: 'student-a', displayName: 'Alice' },
  { id: 'student-b', displayName: 'Bob' },
];

describe('student-switcher component', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
    mock.storage['member-course:refresh-token'] = 'refresh-jwt';
  });

  async function bootstrap() {
    const { currentStudentStore } = await import(
      '../../miniprogram/stores/current-student-store'
    );
    currentStudentStore.restore(STUDENTS, null);
    await import('../../miniprogram/components/student-switcher/index');
    const component = mock.captured.component!;
    return { component, currentStudentStore };
  }

  it('is registered via Component() and declares its public properties', async () => {
    const { component } = await bootstrap();
    expect(component).toBeTruthy();
    // `students` and `currentId` are inputs the host page binds.
    expect(component.properties).toEqual(
      expect.objectContaining({
        students: expect.anything(),
        currentId: expect.anything(),
      }),
    );
  });

  it('mirrors the bound currentId property into data on attach', async () => {
    const { component, currentStudentStore } = await bootstrap();
    // Simulate the host binding current-id="student-a".
    (component.properties as { currentId: string }).currentId =
      currentStudentStore.currentId!;

    component.attached?.();

    expect(component.data.currentId).toBe('student-a');
  });

  it('emits a change event (not the store directly) when a student is tapped', async () => {
    const { component } = await bootstrap();
    const triggerEvent = vi.fn();
    (component as unknown as { triggerEvent?: unknown }).triggerEvent =
      triggerEvent;
    // Current is student-a; tapping student-b should emit.
    component.data.currentId = 'student-a';

    component.onPickStudent?.({
      currentTarget: { dataset: { id: 'student-b' } },
    });

    expect(triggerEvent).toHaveBeenCalledWith('change', { id: 'student-b' });
  });

  it('does not emit when the tapped student is already the current one', async () => {
    const { component } = await bootstrap();
    const triggerEvent = vi.fn();
    (component as unknown as { triggerEvent?: unknown }).triggerEvent =
      triggerEvent;
    component.data.currentId = 'student-a';

    component.onPickStudent?.({
      currentTarget: { dataset: { id: 'student-a' } },
    });

    expect(triggerEvent).not.toHaveBeenCalled();
  });
});
