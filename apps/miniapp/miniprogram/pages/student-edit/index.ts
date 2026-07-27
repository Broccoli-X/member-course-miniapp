import { request, ApiError } from '../../services/http';

interface MemberStudentView {
  student: { id: string; displayName: string; birthDate: string | null };
  relation: { id: string; relationType: string };
}

interface PageData {
  mode: 'create' | 'edit';
  studentId: string | null;
  displayName: string;
  birthDate: string;
  relationship: 'SELF' | 'GUARDIAN';
  submitting: boolean;
}

interface PageInstance extends PageData {
  data: PageData;
  setData(data: Partial<PageData>): void;
  loadStudent(id: string): Promise<void>;
}

type RelationshipPickerEvent = {
  detail: { value: string };
};
type InputEvent = { detail: { value: string } };

const RELATIONSHIP_OPTIONS = ['SELF', 'GUARDIAN'] as const;

/**
 * Create or edit a related student. In create mode the relationship is set
 * (SELF/GUARDIAN); in edit mode only `displayName` and `birthDate` are
 * mutable — the relationship is immutable post-create, so it is never sent in
 * the PATCH body.
 */
Page({
  data: {
    mode: 'create',
    studentId: null,
    displayName: '',
    birthDate: '',
    relationship: 'SELF',
    submitting: false,
  },

  async onLoad(
    this: PageInstance,
    options: { id?: string } | undefined,
  ) {
    if (options?.id) {
      await this.loadStudent(options.id);
    } else {
      this.setData({ mode: 'create', relationship: 'SELF' });
    }
  },

  async loadStudent(this: PageInstance, id: string) {
    try {
      const result = await request<MemberStudentView>({
        path: `/api/mini/v1/students/${id}`,
      });
      // Single setData carrying mode + studentId + loaded fields so callers
      // observe one coherent transition into edit mode.
      this.setData({
        mode: 'edit',
        studentId: id,
        displayName: result.student.displayName,
        birthDate: result.student.birthDate ?? '',
        relationship:
          (result.relation.relationType as PageData['relationship']) ?? 'GUARDIAN',
      });
    } catch (err) {
      this.setData({ mode: 'edit', studentId: id });
      wx.showToast({
        title: err instanceof ApiError ? err.message : '加载学员失败',
        icon: 'none',
      });
    }
  },

  onDisplayNameInput(this: PageInstance, e: InputEvent) {
    this.setData({ displayName: e.detail.value });
  },

  onBirthDateInput(this: PageInstance, e: InputEvent) {
    this.setData({ birthDate: e.detail.value });
  },

  onRelationshipChange(this: PageInstance, e: RelationshipPickerEvent) {
    // radio-group `bindchange` returns the selected radio's value string
    // directly (e.g. 'SELF' / 'GUARDIAN'), not an index.
    const next = RELATIONSHIP_OPTIONS.find((opt) => opt === e.detail.value);
    if (next) this.setData({ relationship: next });
  },

  async onSave(this: PageInstance) {
    const trimmed = this.data.displayName.trim();
    if (!trimmed) {
      wx.showToast({ title: '请填写学员姓名', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      if (this.data.mode === 'create') {
        await request({
          method: 'POST',
          path: '/api/mini/v1/students',
          data: {
            displayName: trimmed,
            birthDate: this.data.birthDate || null,
            relationship: this.data.relationship,
          },
        });
      } else if (this.data.studentId) {
        await request({
          method: 'PATCH',
          path: `/api/mini/v1/students/${this.data.studentId}`,
          data: {
            displayName: trimmed,
            birthDate: this.data.birthDate || null,
          },
        });
      }
      wx.navigateBack();
    } catch (err) {
      wx.showToast({
        title: err instanceof ApiError ? err.message : '保存失败',
        icon: 'none',
      });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
