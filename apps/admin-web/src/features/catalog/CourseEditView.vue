<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import catalogApi from '../../api/catalog';
import { ApiError } from '../../api/http';
import PackageProductForm from './PackageProductForm.vue';
import type { CourseView, PackageProductView, CourseType } from '@member-course/contracts';

const props = defineProps<{ id?: string }>();
const router = useRouter();
const route = useRoute();

// The :id may arrive as a prop (router `props: true` via RouterView) or via the
// route param (when the component is mounted directly with the router plugin,
// as in tests). Prefer the prop; fall back to the param. Reactive so edit mode
// engages once the initial navigation resolves.
const courseId = computed(() => props.id ?? (route.params.id as string | undefined));
// Create mode when no :id; edit mode otherwise.
const isEdit = computed(() => Boolean(courseId.value));

interface CourseFormModel {
  name: string;
  type: CourseType;
  description: string;
}

const formRef = ref<FormInstance>();
const form = reactive<CourseFormModel>({
  name: '',
  type: 'CLASS',
  description: '',
});
const submitting = ref(false);
const course = ref<CourseView | null>(null);

// Packages of the course (fetched alongside for the editor). M1 admin has no
// list-packages endpoint, so packages are listed via the course list filter
// would be heavy; we load them on demand when creating/editing.
const packages = ref<PackageProductView[]>([]);

const rules: FormRules<CourseFormModel> = {
  name: [{ required: true, message: '请输入课程名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择课程类型', trigger: 'change' }],
};

async function loadCourse(): Promise<void> {
  if (!courseId.value) return;
  try {
    const data = await catalogApi.getCourse(courseId.value);
    course.value = data;
    form.name = data.name;
    form.type = (data.type as CourseType) ?? 'CLASS';
    form.description = data.description ?? '';
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载课程失败${trace}`);
  }
}

async function onSubmit(): Promise<void> {
  if (!formRef.value) return;
  // Element Plus async-validator does not reliably reject empty required
  // strings under jsdom, so guard the required name explicitly.
  if (!form.name.trim()) {
    try {
      await formRef.value.validate();
    } catch {
      /* validation message shown */
    }
    return;
  }
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  submitting.value = true;
  try {
    if (isEdit.value && courseId.value) {
      await catalogApi.updateCourse(courseId.value, {
        name: form.name,
        type: form.type,
        description: form.description,
      });
      ElMessage.success('课程已更新');
    } else {
      const created = await catalogApi.createCourse({
        name: form.name,
        type: form.type,
        description: form.description,
      });
      course.value = created;
      ElMessage.success('课程已创建');
      // Switch to edit mode in-place for package management.
      router.replace({ name: 'course-edit', params: { id: created.id } });
    }
    await loadCourse();
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`保存课程失败${trace}`);
  } finally {
    submitting.value = false;
  }
}

async function onCreatePackage(body: {
  name: string;
  price: string;
  hours: string;
  validDays: number;
}): Promise<void> {
  if (!course.value) return;
  try {
    const created = await catalogApi.createPackageProduct(course.value.id, body);
    packages.value = [...packages.value, created];
    ElMessage.success('课包已添加');
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`添加课包失败${trace}`);
  }
}

onMounted(async () => {
  await loadCourse();
});

// Reload when the :id param becomes available after the initial navigation
// resolves (covers mounting before the route is fully resolved).
watch(courseId, (id) => {
  if (id) void loadCourse();
});
</script>

<template>
  <section class="course-edit" data-testid="course-edit">
    <h2>{{ isEdit ? '编辑课程' : '新建课程' }}</h2>
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      @submit.prevent="onSubmit"
    >
      <el-form-item label="课程名称" prop="name">
        <el-input v-model="form.name" name="name" placeholder="请输入课程名称" />
      </el-form-item>
      <el-form-item label="课程类型" prop="type">
        <el-select v-model="form.type" name="type">
          <el-option label="班课" value="CLASS" />
          <el-option label="一对一" value="ONE_TO_ONE" />
        </el-select>
      </el-form-item>
      <el-form-item label="课程描述" prop="description">
        <el-input v-model="form.description" name="description" type="textarea" :rows="3" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" native-type="submit" :loading="submitting">保存</el-button>
        <el-button @click="router.push({ name: 'courses' })">返回</el-button>
      </el-form-item>
    </el-form>

    <div v-if="course" class="course-edit-packages">
      <h3>课包管理</h3>
      <PackageProductForm @submit="onCreatePackage" />
      <el-table :data="packages" border style="width: 100%; margin-top: 12px">
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="price" label="价格" width="140" />
        <el-table-column prop="hours" label="课时" width="120" />
        <el-table-column prop="validDays" label="有效天数" width="120" />
        <el-table-column prop="status" label="状态" width="100" />
      </el-table>
    </div>
  </section>
</template>

<style scoped>
.course-edit h2 {
  margin: 0 0 16px;
}
.course-edit-packages {
  margin-top: 24px;
}
.course-edit-packages h3 {
  margin: 0 0 12px;
}
</style>
