<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import hoursApi from '../../api/hours';
import { ApiError } from '../../api/http';
import type {
  CourseBalanceView,
  CoursePackageView,
  HourTransactionView,
} from '@member-course/contracts';

/**
 * Read-only lesson-hour ledger view for a single student (Tasks 10/11 admin
 * surface). Renders three panels — balances, packages, transactions — all with
 * decimal values kept as 2-dp strings (never coerced to JS number).
 *
 * Exposes a `refresh()` method so a parent (the hours page) can reload all
 * three panels after a manual adjustment command succeeds.
 */
const props = defineProps<{ studentId: string }>();

const balances = ref<CourseBalanceView[]>([]);
const packages = ref<CoursePackageView[]>([]);
const transactions = ref<HourTransactionView[]>([]);
const loading = ref(false);

async function loadBalances(): Promise<void> {
  try {
    const result = await hoursApi.listBalances(props.studentId, { page: 1, pageSize: 20 });
    balances.value = result.items;
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载课时余额失败${trace}`);
  }
}

async function loadPackages(): Promise<void> {
  try {
    const result = await hoursApi.listPackages(props.studentId, { page: 1, pageSize: 20 });
    packages.value = result.items;
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载课时包失败${trace}`);
  }
}

async function loadTransactions(): Promise<void> {
  try {
    const result = await hoursApi.listTransactions(props.studentId, { page: 1, pageSize: 20 });
    transactions.value = result.items;
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载课时流水失败${trace}`);
  }
}

/** Reload all three panels (used by the parent after an adjustment command). */
async function refresh(): Promise<void> {
  loading.value = true;
  try {
    await Promise.all([loadBalances(), loadPackages(), loadTransactions()]);
  } finally {
    loading.value = false;
  }
}

defineExpose({ refresh });

onMounted(() => {
  void refresh();
});
</script>

<template>
  <section class="hour-ledger" data-testid="hour-ledger" v-loading="loading">
    <h3>课时余额</h3>
    <el-table :data="balances" border style="width: 100%">
      <el-table-column prop="courseId" label="课程" />
      <el-table-column prop="available" label="可用" width="120" />
      <el-table-column prop="reserved" label="预留" width="120" />
      <el-table-column prop="consumed" label="已消耗" width="120" />
      <el-table-column prop="expired" label="已过期" width="120" />
    </el-table>

    <h3>课时包</h3>
    <el-table :data="packages" border style="width: 100%">
      <el-table-column prop="courseId" label="课程" />
      <el-table-column prop="sourceType" label="来源" width="120">
        <template #default="{ row }">
          {{
            row.sourceType === 'ORDER'
              ? '订单'
              : row.sourceType === 'MANUAL'
                ? '手动'
                : row.sourceType
          }}
        </template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="100" />
      <el-table-column prop="startsOn" label="生效日" width="120" />
      <el-table-column prop="expiresOn" label="到期日" width="120" />
      <el-table-column prop="granted" label="发放" width="100" />
      <el-table-column prop="available" label="可用" width="100" />
      <el-table-column prop="consumed" label="已消耗" width="100" />
    </el-table>

    <h3>课时流水</h3>
    <el-table :data="transactions" border style="width: 100%">
      <el-table-column prop="type" label="类型" width="140">
        <template #default="{ row }">
          {{
            row.type === 'GRANT'
              ? '发放'
              : row.type === 'DEBIT'
                ? '消耗'
                : row.type === 'MANUAL_GRANT'
                  ? '手动发放'
                  : row.type === 'MANUAL_DEDUCT'
                    ? '手动扣减'
                    : row.type === 'REVERSAL'
                      ? '冲销'
                      : row.type === 'EXPIRE'
                        ? '过期'
                        : row.type
          }}
        </template>
      </el-table-column>
      <el-table-column prop="courseId" label="课程" />
      <el-table-column prop="availableDelta" label="可用变动" width="120" />
      <el-table-column prop="consumedDelta" label="消耗变动" width="120" />
      <el-table-column prop="reason" label="原因">
        <template #default="{ row }">{{ row.reason ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="occurredAt" label="时间" width="180" />
    </el-table>
  </section>
</template>

<style scoped>
.hour-ledger h3 {
  margin: 20px 0 12px;
}
.hour-ledger h3:first-child {
  margin-top: 0;
}
</style>
