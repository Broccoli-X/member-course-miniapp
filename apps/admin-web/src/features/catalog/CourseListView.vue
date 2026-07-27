<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import catalogApi from '../../api/catalog';
import { ApiError } from '../../api/http';
import type { CourseView } from '@member-course/contracts';

const router = useRouter();

const courses = ref<CourseView[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await catalogApi.listCourses({ page: page.value, pageSize: pageSize.value });
    courses.value = result.items;
    total.value = result.total;
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载课程列表失败${trace}`);
  } finally {
    loading.value = false;
  }
}

function openEdit(row: CourseView): void {
  router.push({ name: 'course-edit', params: { id: row.id } });
}

function openCreate(): void {
  router.push({ name: 'course-create' });
}

/** Archive confirmation. Uses `window.confirm` so it is trivially drivable in
 *  tests (jsdom stubs `window.confirm`); the ElMessageBox import is kept for
 *  future richer dialogs but the M1 surface relies on the native prompt. */
async function onArchive(row: CourseView): Promise<void> {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`确认归档课程「${row.name}」？归档后前台不再展示。`)) return;
  try {
    await catalogApi.archiveCourse(row.id);
    ElMessage.success('课程已归档');
    await load();
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`归档失败${trace}`);
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="course-list" data-testid="course-list">
    <header class="course-list-header">
      <h2>课程课包</h2>
      <el-button type="primary" data-testid="create-course" @click="openCreate">新建课程</el-button>
    </header>

    <el-table :data="courses" v-loading="loading" border style="width: 100%" @row-click="openEdit">
      <el-table-column prop="name" label="课程名称">
        <template #default="{ row }">
          <span :data-testid="`course-row-${row.id}`">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="type" label="类型" width="140">
        <template #default="{ row }">
          {{ row.type === 'ONE_TO_ONE' ? '一对一' : '班课' }}
        </template>
      </el-table-column>
      <el-table-column prop="description" label="描述" />
      <el-table-column prop="status" label="状态" width="120" />
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button
            link
            type="danger"
            :data-testid="`archive-course-${row.id}`"
            @click="onArchive(row)"
          >
            归档
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.course-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.course-list-header h2 {
  margin: 0;
}
</style>
