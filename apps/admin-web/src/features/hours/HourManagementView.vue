<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import membersApi from '../../api/members';
import { ApiError } from '../../api/http';
import HourLedgerTable from './HourLedgerTable.vue';
import HourAdjustmentDialog from './HourAdjustmentDialog.vue';
import type { MemberDetailView } from '@member-course/contracts';

/**
 * Lesson-hour management page (Task 13).
 *
 * Operator picks a member → the member's students are listed → picking a
 * student loads that student's hour ledger (balances/packages/transactions)
 * and offers the manual grant/debit dialog. After a successful adjustment the
 * ledger reloads so the operator sees the new balance immediately.
 */
const members = ref<Awaited<ReturnType<typeof membersApi.listMembers>>['items']>([]);
const selectedMemberId = ref('');
const memberDetail = ref<MemberDetailView | null>(null);
const selectedStudentId = ref('');
const selectedCourseId = ref('');

async function loadMembers(): Promise<void> {
  try {
    const result = await membersApi.listMembers({ page: 1, pageSize: 100 });
    members.value = result.items;
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载会员失败${trace}`);
  }
}

async function onMemberChange(): Promise<void> {
  memberDetail.value = null;
  selectedStudentId.value = '';
  selectedCourseId.value = '';
  if (!selectedMemberId.value) return;
  try {
    memberDetail.value = await membersApi.getMember(selectedMemberId.value);
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载会员详情失败${trace}`);
  }
}

const ledger = ref<InstanceType<typeof HourLedgerTable> | null>(null);

async function onAdjusted(): Promise<void> {
  // Refresh the ledger panels after a successful adjustment command.
  await ledger.value?.refresh();
}

onMounted(() => {
  void loadMembers();
});
</script>

<template>
  <section class="hour-management" data-testid="hour-management">
    <h2>课时管理</h2>

    <div class="hour-management-picker">
      <el-select
        v-model="selectedMemberId"
        placeholder="选择会员"
        filterable
        style="width: 240px"
        @change="onMemberChange"
      >
        <el-option
          v-for="m in members"
          :key="m.id"
          :label="m.normalizedPhone ?? m.id"
          :value="m.id"
        />
      </el-select>
      <el-select
        v-if="memberDetail"
        v-model="selectedStudentId"
        placeholder="选择学员"
        filterable
        style="width: 200px"
      >
        <el-option
          v-for="s in memberDetail.students"
          :key="s.id"
          :label="s.displayName"
          :value="s.id"
        />
      </el-select>
      <el-input
        v-if="selectedStudentId"
        v-model="selectedCourseId"
        placeholder="课程 ID（在课程课包中查看）"
        style="width: 260px"
      />
    </div>

    <template v-if="selectedStudentId">
      <HourLedgerTable
        v-if="!selectedCourseId"
        ref="ledger"
        :student-id="selectedStudentId"
      />
      <template v-else>
        <HourLedgerTable ref="ledger" :student-id="selectedStudentId" />
        <div class="hour-management-adjust">
          <h3>手动调整</h3>
          <HourAdjustmentDialog
            :student-id="selectedStudentId"
            :course-id="selectedCourseId"
            @submitted="onAdjusted"
          />
        </div>
      </template>
    </template>
    <p v-else class="hour-management-empty">请先选择会员和学员。</p>
  </section>
</template>

<style scoped>
.hour-management h2 {
  margin: 0 0 16px;
}
.hour-management-picker {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 16px;
}
.hour-management-adjust {
  margin-top: 24px;
}
.hour-management-adjust h3 {
  margin: 0 0 12px;
}
.hour-management-empty {
  color: #909399;
  font-size: 13px;
}
</style>
