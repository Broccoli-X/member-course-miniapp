<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import type { AdminCreateStudentRequest, RelationType } from '@member-course/contracts';

interface StudentFormModel {
  displayName: string;
  relationType: RelationType;
  birthDate: string;
}

const props = defineProps<{ modelValue?: boolean }>();
const emit = defineEmits<{
  (e: 'submit', payload: AdminCreateStudentRequest): void;
  (e: 'update:modelValue', value: boolean): void;
}>();

const formRef = ref<FormInstance>();
const form = reactive<StudentFormModel>({
  displayName: '',
  // Admin-created children default to GUARDIAN (the member is the guardian).
  relationType: 'GUARDIAN',
  birthDate: '',
});

const rules: FormRules<StudentFormModel> = {
  displayName: [{ required: true, message: '请输入学员姓名', trigger: 'blur' }],
  relationType: [{ required: true, message: '请选择关系', trigger: 'change' }],
};

/** Payload sent to the parent: trims empty birthDate to null. */
const payload = computed<AdminCreateStudentRequest>(() => ({
  displayName: form.displayName.trim(),
  relationType: form.relationType,
  birthDate: form.birthDate ? form.birthDate : null,
}));

async function onSubmit(): Promise<void> {
  if (!formRef.value) return;
  // Element Plus's bundled async-validator does not reliably reject empty
  // strings for `required` rules under jsdom, so guard the required display
  // name explicitly and surface the error via the form ref's validate().
  if (!form.displayName.trim()) {
    try {
      await formRef.value.validate();
    } catch {
      /* validation errors are shown on the fields */
    }
    return;
  }
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  emit('submit', payload.value);
  emit('update:modelValue', false);
}

function close(): void {
  emit('update:modelValue', false);
}

defineExpose({ form });
</script>

<template>
  <el-form
    ref="formRef"
    :model="form"
    :rules="rules"
    label-position="top"
    data-testid="student-form"
    @submit.prevent="onSubmit"
  >
    <el-form-item label="学员姓名" prop="displayName">
      <el-input v-model="form.displayName" name="displayName" placeholder="请输入学员姓名" />
    </el-form-item>
    <el-form-item label="关系" prop="relationType">
      <el-select v-model="form.relationType" name="relationType" placeholder="请选择关系">
        <el-option label="家长/监护人" value="GUARDIAN" />
        <el-option label="本人" value="SELF" />
        <el-option label="父母" value="PARENT" />
      </el-select>
    </el-form-item>
    <el-form-item label="出生日期（可选）" prop="birthDate">
      <el-input v-model="form.birthDate" name="birthDate" type="date" />
    </el-form-item>
    <div class="student-form-actions">
      <el-button type="primary" native-type="submit" data-testid="student-submit">保存</el-button>
      <el-button data-testid="student-cancel" @click="close">取消</el-button>
    </div>
  </el-form>
</template>

<style scoped>
.student-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
