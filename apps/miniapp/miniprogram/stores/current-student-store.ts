/**
 * Currently-selected related student.
 *
 * Holds ONLY the student id in storage (under
 * `member-course:selected-student-id`). The student profile payload is never
 * persisted — it is re-fetched from the server on each launch. The full
 * related-students list is supplied to {@link restore} so the persisted id can
 * be validated against the live set.
 */

const SELECTED_STUDENT_STORAGE_KEY = 'member-course:selected-student-id';

export interface RelatedStudentRef {
  readonly id: string;
  readonly [key: string]: unknown;
}

interface InternalState {
  currentId: string | null;
  relatedIds: ReadonlySet<string>;
}

let state: InternalState = { currentId: null, relatedIds: new Set() };

function readPersistedId(): string | null {
  const value = wx.getStorageSync(SELECTED_STUDENT_STORAGE_KEY);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function persistId(id: string | null): void {
  if (id && id.length > 0) {
    wx.setStorageSync(SELECTED_STUDENT_STORAGE_KEY, id);
  } else {
    wx.removeStorageSync(SELECTED_STUDENT_STORAGE_KEY);
  }
}

export const currentStudentStore = {
  get currentId(): string | null {
    return state.currentId;
  },

  /**
   * Reconcile the selection against the live related-students list.
   * - If `preferredId` is provided AND in the list → keep it.
   * - If `preferredId` is provided but NOT in the list (e.g. an archived
   *   student, or the verbatim `'student-other'` case) → fall back to the
   *     first related student.
   *   - If `preferredId` is null (cold launch) → hydrate from storage; use the
   *     persisted id only if it's still related, else fall back to the first.
   *   - Empty list → clear the selection.
   * The reconciled id is re-persisted so re-entry lands on the same student.
   */
  restore(related: ReadonlyArray<RelatedStudentRef>, preferredId: string | null): void {
    const ids = new Set(related.map((s) => s.id));
    const candidate =
      preferredId !== null ? preferredId : readPersistedId();
    let next: string | null;
    if (candidate !== null && ids.has(candidate)) {
      next = candidate;
    } else if (related.length > 0) {
      next = related[0]!.id;
    } else {
      next = null;
    }
    state = { currentId: next, relatedIds: ids };
    persistId(next);
  },

  /** Change the active student. Throws if the id isn't in the related list. */
  select(studentId: string): void {
    if (!state.relatedIds.has(studentId)) {
      throw new Error(
        `student ${studentId} is not in the related list; cannot select`,
      );
    }
    state = { ...state, currentId: studentId };
    persistId(studentId);
  },

  /** Drop the persisted selection on logout / account change. */
  clear(): void {
    state = { currentId: null, relatedIds: new Set() };
    persistId(null);
  },

  /** Re-hydrate from storage on a cold launch (id only; no profile payloads). */
  hydrate(): string | null {
    return readPersistedId();
  },
};
