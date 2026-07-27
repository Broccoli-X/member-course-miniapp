<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import ordersApi from '../../api/orders';
import { ApiError } from '../../api/http';
import type { OfflineOrderDto } from '@member-course/contracts';

const router = useRouter();

const orders = ref<OfflineOrderDto[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const statusFilter = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await ordersApi.listOrders({
      page: page.value,
      pageSize: pageSize.value,
      ...(statusFilter.value ? { status: statusFilter.value } : {}),
    });
    orders.value = result.items;
    total.value = result.total;
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载订单列表失败${trace}`);
  } finally {
    loading.value = false;
  }
}

function onSearch(): void {
  page.value = 1;
  void load();
}

function onNextPage(): void {
  page.value += 1;
  void load();
}

function onPrevPage(): void {
  if (page.value > 1) {
    page.value -= 1;
    void load();
  }
}

function openCreate(): void {
  router.push({ name: 'order-create' });
}

function openDetail(row: OfflineOrderDto): void {
  router.push({ name: 'order-detail', params: { id: row.id } });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="order-list" data-testid="order-list">
    <header class="order-list-header">
      <h2>线下订单</h2>
      <div class="order-list-tools">
        <el-select
          v-model="statusFilter"
          data-testid="status-filter"
          placeholder="全部状态"
          clearable
          style="width: 160px"
          @change="onSearch"
        >
          <el-option label="待确认" value="PENDING" />
          <el-option label="已确认" value="CONFIRMED" />
          <el-option label="已冲销" value="REVERSED" />
        </el-select>
        <el-button type="primary" data-testid="order-search" @click="onSearch">筛选</el-button>
        <el-button type="success" data-testid="create-order" @click="openCreate">新建订单</el-button>
      </div>
    </header>

    <el-table :data="orders" v-loading="loading" border style="width: 100%">
      <el-table-column prop="id" label="订单号">
        <template #default="{ row }">
          <span :data-testid="`order-row-${row.id}`">{{ row.id }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="buyerAccountId" label="购买会员" />
      <el-table-column prop="status" label="状态" width="120">
        <template #default="{ row }">
          {{
            row.status === 'PENDING'
              ? '待确认'
              : row.status === 'CONFIRMED'
                ? '已确认'
                : row.status === 'REVERSED'
                  ? '已冲销'
                  : row.status
          }}
        </template>
      </el-table-column>
      <el-table-column prop="totalAmount" label="总金额" width="140" />
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button
            link
            type="primary"
            :data-testid="`open-order-${row.id}`"
            @click="openDetail(row)"
          >
            详情
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <footer class="order-pager">
      <el-button data-testid="prev-page" :disabled="page <= 1" @click="onPrevPage">上一页</el-button>
      <span class="order-pager-info">第 {{ page }} 页 / 共 {{ Math.max(1, Math.ceil(total / pageSize)) }} 页（{{ total }} 条）</span>
      <el-button data-testid="next-page" @click="onNextPage">下一页</el-button>
    </footer>
  </section>
</template>

<style scoped>
.order-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.order-list-header h2 {
  margin: 0;
}
.order-list-tools {
  display: flex;
  gap: 8px;
  align-items: center;
}
.order-pager {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  justify-content: flex-end;
}
.order-pager-info {
  font-size: 13px;
  color: #606266;
}
</style>
