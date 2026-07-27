<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import ordersApi from '../../api/orders';
import { ApiError } from '../../api/http';
import type { OfflineOrderDto } from '@member-course/contracts';

const props = defineProps<{ id?: string }>();
const router = useRouter();
const route = useRoute();
const orderId = computed(() => (props.id ?? (route.params.id as string)) ?? '');

/**
 * RFC4122 v4 UUID via the Web Crypto API (available in browsers and Node ≥ 19).
 * Used to mint one-time Idempotency-Keys for confirm/void/reverse so a doubled
 * submit collapses to a single server-side execution.
 */
function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

const order = ref<OfflineOrderDto | null>(null);
const loading = ref(false);
/** Human-readable reversal message (e.g. why a used order can't be reversed). */
const reverseMessage = ref('');

// ── Idempotency keys ───────────────────────────────────────────────────────
// Each logical action (confirm/void/reverse) gets ONE stable key, generated
// lazily on first use and REUSED for every retry/double-click of that action.
// The server dedupes by the Idempotency-Key header, so reusing the same key
// means a doubled submit executes the work exactly once. A key is regenerated
// only when a fresh action begins (the previous one failed/succeeded and a new
// user gesture starts a new logical action).
let confirmKey: string | null = null;
let voidKey: string | null = null;
let reverseKey: string | null = null;
// in-flight guards so concurrent clicks of the SAME action collapse to one call.
const confirming = ref(false);
const voiding = ref(false);
const reversing = ref(false);

async function load(): Promise<void> {
  if (!orderId.value) return;
  loading.value = true;
  reverseMessage.value = '';
  try {
    order.value = await ordersApi.getOrder(orderId.value);
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载订单失败${trace}`);
  } finally {
    loading.value = false;
  }
}

const isPending = computed(() => order.value?.status === 'PENDING');
const isConfirmed = computed(() => order.value?.status === 'CONFIRMED');
/** A confirmed order can be edited (reversed) but a pending one is confirmed/voided. */
const canConfirm = computed(() => isPending.value && !confirming.value);
const canVoid = computed(() => isPending.value && !voiding.value);
const canReverse = computed(() => isConfirmed.value && !reversing.value);

async function onConfirm(): Promise<void> {
  if (!order.value || !isPending.value || confirming.value) return;
  // Generate the idempotency key ONCE for this logical confirm; reuse it for
  // any retry so a double-click only runs the work once.
  if (!confirmKey) confirmKey = `confirm:${orderId.value}:${randomUUID()}`;
  confirming.value = true;
  try {
    await ordersApi.confirmOrder(order.value.id, confirmKey);
    ElMessage.success('订单已确认，课时已发放');
    await load();
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`确认订单失败${trace}`);
  } finally {
    confirming.value = false;
  }
}

async function onVoid(): Promise<void> {
  if (!order.value || !isPending.value || voiding.value) return;
  // eslint-disable-next-line no-alert
  if (!window.confirm('确认作废该草稿订单？作废后不可恢复。')) return;
  if (!voidKey) voidKey = `void:${orderId.value}:${randomUUID()}`;
  voiding.value = true;
  try {
    await ordersApi.voidOrder(order.value.id, voidKey);
    ElMessage.success('订单已作废');
    // A voided draft is physically removed; go back to the list.
    router.push({ name: 'orders' });
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`作废订单失败${trace}`);
  } finally {
    voiding.value = false;
  }
}

async function onReverse(): Promise<void> {
  if (!order.value || !isConfirmed.value || reversing.value) return;
  // eslint-disable-next-line no-alert
  const reason = window.prompt('请输入冲销原因（必填）', '');
  if (reason === null) return;
  const trimmed = reason.trim();
  if (!trimmed) {
    ElMessage.warning('冲销订单必须填写原因');
    return;
  }
  if (!reverseKey) reverseKey = `reverse:${orderId.value}:${randomUUID()}`;
  reversing.value = true;
  reverseMessage.value = '';
  try {
    await ordersApi.reverseOrder(order.value.id, { reason: trimmed }, reverseKey);
    ElMessage.success('订单已冲销');
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'ORDER_NOT_REVERSIBLE') {
      // A used order has downstream consumption/adjustments — explain WHY.
      reverseMessage.value = '该订单课包已有消耗或调整记录，无法冲销，请先回滚相关课时操作。';
    } else {
      const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
      ElMessage.error(`冲销订单失败${trace}`);
    }
  } finally {
    reversing.value = false;
  }
}

function back(): void {
  router.push({ name: 'orders' });
}

onMounted(() => {
  void load();
});

watch(orderId, (id) => {
  if (id) void load();
});
</script>

<template>
  <section v-if="order" class="order-detail" data-testid="order-detail" v-loading="loading">
    <header class="order-detail-header">
      <div>
        <h2>订单详情</h2>
        <p class="order-detail-meta">
          订单号：{{ order.id }} · 状态：{{ order.status }} · 总金额：{{ order.totalAmount }}
        </p>
      </div>
      <el-button @click="back">返回列表</el-button>
    </header>

    <div class="order-detail-actions">
      <el-button
        v-if="isPending"
        type="primary"
        data-testid="confirm-order"
        :loading="confirming"
        :disabled="!canConfirm"
        @click="onConfirm"
      >
        确认订单
      </el-button>
      <el-button
        v-if="isPending"
        type="warning"
        data-testid="void-order"
        :loading="voiding"
        :disabled="!canVoid"
        @click="onVoid"
      >
        作废草稿
      </el-button>
      <el-button
        v-if="isConfirmed"
        type="danger"
        data-testid="reverse-order"
        :loading="reversing"
        :disabled="!canReverse"
        @click="onReverse"
      >
        冲销订单
      </el-button>
    </div>

    <p v-if="reverseMessage" class="order-detail-warn" data-testid="reverse-message">
      {{ reverseMessage }}
    </p>

    <h3>订单明细</h3>
    <el-table :data="order.items" border style="width: 100%">
      <el-table-column prop="studentId" label="学员" />
      <el-table-column prop="productNameSnapshot" label="课包" />
      <el-table-column prop="unitPriceSnapshot" label="单价" width="140" />
      <el-table-column prop="hoursSnapshot" label="课时" width="120" />
      <el-table-column prop="validDaysSnapshot" label="有效天数" width="120" />
      <el-table-column label="课包/发放">
        <template #default="{ row }">
          {{ row.coursePackageId ?? '—' }}
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.order-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}
.order-detail-header h2 {
  margin: 0 0 4px;
}
.order-detail-meta {
  margin: 0;
  color: #606266;
  font-size: 13px;
}
.order-detail-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.order-detail-warn {
  color: #e6a23c;
  background: #fdf6ec;
  border: 1px solid #f5dab1;
  padding: 8px 12px;
  border-radius: 4px;
  margin: 0 0 16px;
  font-size: 13px;
}
.order-detail h3 {
  margin: 16px 0 12px;
}
</style>
