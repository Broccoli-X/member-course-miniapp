<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import membersApi from '../../api/members';
import ordersApi from '../../api/orders';
import { ApiError } from '../../api/http';
import type {
  MemberAccountView,
  MemberDetailView,
  CreateOfflineOrderCommand,
} from '@member-course/contracts';

const router = useRouter();

interface DraftItem {
  studentId: string;
  productId: string;
}

const members = ref<MemberAccountView[]>([]);
const memberDetail = ref<MemberDetailView | null>(null);
const submitting = ref(false);

const buyerAccountId = ref('');
const draft = reactive<DraftItem>({ studentId: '', productId: '' });
const items = ref<DraftItem[]>([]);

const students = ref<Array<{ id: string; displayName: string }>>([]);

async function loadMembers(): Promise<void> {
  try {
    const result = await membersApi.listMembers({ page: 1, pageSize: 100 });
    members.value = result.items;
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载会员失败${trace}`);
  }
}

async function onBuyerChange(): Promise<void> {
  if (!buyerAccountId.value) {
    memberDetail.value = null;
    students.value = [];
    return;
  }
  try {
    memberDetail.value = await membersApi.getMember(buyerAccountId.value);
    students.value = memberDetail.value.students.map((s) => ({
      id: s.id,
      displayName: s.displayName,
    }));
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载会员学员失败${trace}`);
    students.value = [];
  }
}

function addItem(): void {
  if (!draft.studentId || !draft.productId) {
    ElMessage.warning('请选择学员和课包');
    return;
  }
  items.value = [...items.value, { studentId: draft.studentId, productId: draft.productId }];
  draft.studentId = '';
  draft.productId = '';
}

function removeItem(index: number): void {
  items.value = items.value.filter((_, i) => i !== index);
}

async function onSubmit(): Promise<void> {
  if (!buyerAccountId.value) {
    ElMessage.warning('请选择购买会员');
    return;
  }
  if (items.value.length === 0) {
    ElMessage.warning('请至少添加一条订单明细');
    return;
  }
  const command: CreateOfflineOrderCommand = {
    buyerAccountId: buyerAccountId.value,
    items: items.value.map((it) => ({ studentId: it.studentId, productId: it.productId })),
  };
  submitting.value = true;
  try {
    const created = await ordersApi.createOrder(command);
    ElMessage.success('订单草稿已创建');
    router.push({ name: 'order-detail', params: { id: created.id } });
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`创建订单失败${trace}`);
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  await loadMembers();
});
</script>

<template>
  <section class="order-create" data-testid="order-create">
    <h2>新建线下订单</h2>
    <el-form label-position="top">
      <el-form-item label="购买会员">
        <el-select
          v-model="buyerAccountId"
          name="buyerAccountId"
          placeholder="选择购买会员"
          filterable
          style="width: 320px"
          @change="onBuyerChange"
        >
          <el-option
            v-for="m in members"
            :key="m.id"
            :label="m.normalizedPhone ?? m.id"
            :value="m.id"
          />
        </el-select>
      </el-form-item>
    </el-form>

    <h3>添加订单明细</h3>
    <div class="order-create-item">
      <el-select
        v-model="draft.studentId"
        name="studentId"
        placeholder="选择学员"
        filterable
        style="width: 200px"
      >
        <el-option
          v-for="s in students"
          :key="s.id"
          :label="s.displayName"
          :value="s.id"
        />
      </el-select>
      <el-input
        v-model="draft.productId"
        name="productId"
        placeholder="课包 ID（在课程课包中查看）"
        style="width: 280px"
      />
      <el-button type="primary" data-testid="add-item" @click="addItem">添加</el-button>
    </div>

    <el-table :data="items" border style="width: 100%; margin-top: 12px">
      <el-table-column prop="studentId" label="学员" />
      <el-table-column prop="productId" label="课包" />
      <el-table-column label="操作" width="120">
        <template #default="{ $index }">
          <el-button link type="danger" @click="removeItem($index)">移除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="order-create-actions">
      <el-button
        type="primary"
        data-testid="submit-order"
        :loading="submitting"
        @click="onSubmit"
      >
        创建草稿
      </el-button>
      <el-button @click="router.push({ name: 'orders' })">取消</el-button>
    </div>
  </section>
</template>

<style scoped>
.order-create h2 {
  margin: 0 0 16px;
}
.order-create h3 {
  margin: 20px 0 12px;
}
.order-create-item {
  display: flex;
  gap: 8px;
  align-items: center;
}
.order-create-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
</style>
