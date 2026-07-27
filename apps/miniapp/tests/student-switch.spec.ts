import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from './helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// Current-student store: which related student a bound member is acting on.
// The selected id is persisted so re-entry lands on the same student; restore
// picks the previously-selected id if it's still related, else the first
// related student.
// ────────────────────────────────────────────────────────────────────────────

const SELECTED_STUDENT_KEY = 'member-course:selected-student-id';

describe('current-student store', () => {
  let mock: ReturnType<typeof installWxGlobals>;
  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
  });

  it('restores the selected related student only', async () => {
    const { currentStudentStore } = await import(
      '../miniprogram/stores/current-student-store'
    );

    currentStudentStore.restore([{ id: 'student-1' }], 'student-other');
    expect(currentStudentStore.currentId).toBe('student-1');
  });

  it('keeps the previously selected id when it is still related', async () => {
    const { currentStudentStore } = await import(
      '../miniprogram/stores/current-student-store'
    );

    currentStudentStore.restore(
      [{ id: 'student-a' }, { id: 'student-b' }],
      'student-b',
    );
    expect(currentStudentStore.currentId).toBe('student-b');
  });

  it('falls back to the first related student when the list is empty', async () => {
    const { currentStudentStore } = await import(
      '../miniprogram/stores/current-student-store'
    );

    currentStudentStore.restore([], 'student-other');
    expect(currentStudentStore.currentId).toBe(null);
  });

  it('persists the selected id across re-entry', async () => {
    const { currentStudentStore } = await import(
      '../miniprogram/stores/current-student-store'
    );

    currentStudentStore.restore([{ id: 'student-a' }, { id: 'student-b' }], null);
    expect(currentStudentStore.currentId).toBe('student-a');
    currentStudentStore.select('student-b');
    expect(mock.storage[SELECTED_STUDENT_KEY]).toBe('student-b');

    // Re-entry: a fresh store instance reads the persisted id and restores it.
    vi.resetModules();
    const { currentStudentStore: fresh } = await import(
      '../miniprogram/stores/current-student-store'
    );
    fresh.restore([{ id: 'student-a' }, { id: 'student-b' }], null);
    expect(fresh.currentId).toBe('student-b');
  });

  it('select throws when the id is not in the related list', async () => {
    const { currentStudentStore } = await import(
      '../miniprogram/stores/current-student-store'
    );

    currentStudentStore.restore([{ id: 'student-a' }], null);
    expect(() => currentStudentStore.select('student-ghost')).toThrow();
  });

  it('never persists student profile payloads — only the id', async () => {
    const { currentStudentStore } = await import(
      '../miniprogram/stores/current-student-store'
    );

    currentStudentStore.restore(
      [
        {
          id: 'student-a',
          displayName: 'Alice',
          birthDate: '2018-01-01',
        },
      ],
      null,
    );
    currentStudentStore.select('student-a');
    expect(Object.keys(mock.storage)).toEqual([SELECTED_STUDENT_KEY]);
    expect(mock.storage[SELECTED_STUDENT_KEY]).toBe('student-a');
  });
});
