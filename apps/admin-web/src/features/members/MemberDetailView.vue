<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import membersApi from '../../api/members';
import { ApiError } from '../../api/http';
import StudentForm from './StudentForm.vue';
import type { MemberDetailView as MemberDetailViewType } from '@member-course/contracts';
import type { AdminCreateStudentRequest } from '@member-course/contracts';

const route = useRoute();
const props = defineProps<{ id?: string }>();
// Prefer the `id` prop (router `props: true`); fall back to the route param.
// Reactive so the detail reloads if the param changes without remount.
const memberId = computed(() => (props.id ?? (route.params.id as string)) ?? '');

const member = ref<MemberDetailViewType | null>(null);
const loading = ref(false);
const showStudentForm = ref(false);

async function load(): Promise<void> {
  if (!memberId.value) return;
  loading.value = true;
  try {
    member.value = await membersApi.getMember(memberId.value);
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载会员详情失败${trace}`);
  } finally {
    loading.value = false;
  }
}

/** Pre-create a child under the selected member (verbatim test target). */
async function onCreateStudent(payload: AdminCreateStudentRequest): Promise<void> {
  try {
    await membersApi.createStudent(memberId.value, payload);
    showStudentForm.value = false;
    ElMessage.success('学员已添加');
    await load();
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`添加学员失败${trace}`);
  }
}

async function onUnlink(studentId: string, accountId: string): Promise<void> {
  try {
    await ElMessageBox.confirm('确认解除该学员的关联关系？', '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await membersApi.unlinkRelation(studentId, accountId);
    ElMessage.success('已解除关联');
    await load();
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`解除关联失败${trace}`);
  }
}

onMounted(() => {
  void load();
});

// Re-load when the route param becomes available or changes (covers the case
// where the component mounts before the initial navigation has resolved, so
// `memberId` was empty at mount time).
watch(memberId, (id) => {
  if (id) void load();
});
</script>

<template>
  <section v-if="member" class="member-detail" data-testid="member-detail" v-loading="loading">
    <header class="member-detail-header">
      <div>
        <h2>会员详情</h2>
        <p class="member-detail-meta">
          手机号：{{ member.account.normalizedPhone ?? '未绑定' }} · 状态：{{ member.account.status }}
        </p>
      </div>
      <el-button
        type="primary"
        data-testid="add-student"
        @click="showStudentForm = true"
      >
        添加学员
      </el-button>
    </header>

    <div v-if="showStudentForm" class="member-detail-form">
      <StudentForm v-model="showStudentForm" @submit="onCreateStudent" />
    </div>

    <h3>学员列表</h3>
    <el-table :data="member.students" border style="width: 100%">
      <el-table-column prop="displayName" label="姓名" />
      <el-table-column label="出生日期">
        <template #default="{ row }">{{ row.birthDate ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="relation.relationType" label="关系" width="120" />
      <el-table-column prop="status" label="状态" width="120" />
      <el-table-column label="操作" width="140">
        <template #default="{ row }">
          <el-button
            link
            type="danger"
            @click="onUnlink(row.id, row.relation.accountId)"
          >
            解除关联
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.member-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}
.member-detail-header h2 {
  margin: 0 0 4px;
}
.member-detail-meta {
  margin: 0;
  color: #606266;
  font-size: 13px;
}
.member-detail-form {
  margin-bottom: 20px;
  padding: 16px;
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 4px;
}
.member-detail h3 {
  margin: 16px 0 12px;
}
</style>
