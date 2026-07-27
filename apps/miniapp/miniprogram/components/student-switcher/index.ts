/**
 * student-switcher component.
 *
 * Reusable picker for the active related student. Embedded by the my,
 * packages, and hour-transactions pages (registered in their `usingComponents`
 * as `student-switcher`). Inputs:
 *   - `students`   : the related-students list (id + displayName).
 *   - `currentId`  : the currently active student id.
 *
 * On tap, the component emits a `change` event with `{id}` and lets the HOST
 * decide what to do (update the store, clear cached assets, reload). It never
 * mutates the store itself — that keeps the data-clear contract centralized
 * in the host page. Re-tapping the already-active student is a no-op.
 *
 * The active id is mirrored into `data.currentId` so the template can render
 * the active chip; an observer keeps it in sync when the host updates the
 * `currentId` property.
 */

interface StudentOption {
  id: string;
  displayName: string;
}

interface SwitcherData {
  students: StudentOption[];
  currentId: string | null;
}

interface SwitcherInstance {
  data: SwitcherData;
  properties: { students: unknown; currentId: unknown };
  setData(data: Partial<SwitcherData>): void;
  triggerEvent(name: string, detail: unknown): void;
}

Component({
  properties: {
    students: {
      type: Array,
      value: [] as StudentOption[],
    },
    currentId: {
      type: String,
      value: '',
    },
  },
  data: {
    students: [] as StudentOption[],
    currentId: null as string | null,
  },

  observers: {
    // Keep `data.currentId` in sync with the property so the template's
    // `currentId === item.id` comparison works on the data binding.
    currentId(value: string): void {
      this.setData({ currentId: value || null });
    },
  },

  attached(this: SwitcherInstance) {
    // Seed data from the initial property values (covers the first render
    // before any observer fires).
    const fromProp = this.properties.currentId;
    this.setData({ currentId: (fromProp as string) || null });
  },

  methods: {
    onPickStudent(
      this: SwitcherInstance,
      e: { currentTarget: { dataset: { id: string } } },
    ): void {
      const id = e.currentTarget.dataset.id;
      // No-op when the member re-taps the already-active student.
      if (id === this.data.currentId) return;
      this.triggerEvent('change', { id });
    },
  },
});

export {};
