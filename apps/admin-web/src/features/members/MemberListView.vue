<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import membersApi from '../../api/members';
import { ApiError } from '../../api/http';
import type { MemberAccountView } from '@member-course/contracts';

const router = useRouter();

const members = ref<MemberAccountView[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const phone = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await membersApi.listMembers({
      page: page.value,
      pageSize: pageSize.value,
      ...(phone.value ? { phone: phone.value } : {}),
    });
    members.value = result.items;
    total.value = result.total;
  } catch (err) {
    const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
    ElMessage.error(`加载会员列表失败${trace}`);
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

function openDetail(row: MemberAccountView): void {
  router.push({ name: 'member-detail', params: { id: row.id } });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="member-list" data-testid="member-list">
    <header class="member-list-header">
      <h2>会员学员</h2>
      <div class="member-search">
        <el-input
          v-model="phone"
          name="phone"
          placeholder="按手机号搜索"
          clearable
          @keyup.enter="onSearch"
        />
        <el-button type="primary" data-testid="member-search" @click="onSearch">搜索</el-button>
      </div>
    </header>

    <el-table :data="members" v-loading="loading" border style="width: 100%">
      <el-table-column prop="normalizedPhone" label="手机号" />
      <el-table-column prop="status" label="状态" width="120" />
      <el-table-column prop="isProvisional" label="未绑机" width="100">
        <template #default="{ row }">
          {{ row.isProvisional ? '是' : '否' }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <footer class="member-pager">
      <el-button data-testid="prev-page" :disabled="page <= 1" @click="onPrevPage">上一页</el-button>
      <span class="member-pager-info">第 {{ page }} 页 / 共 {{ Math.max(1, Math.ceil(total / pageSize)) }} 页（{{ total }} 条）</span>
      <el-button data-testid="next-page" @click="onNextPage">下一页</el-button>
    </footer>
  </section>
</template>

<style scoped>
.member-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.member-list-header h2 {
  margin: 0;
}
.member-search {
  display: flex;
  gap: 8px;
  width: 320px;
}
.member-pager {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  justify-content: flex-end;
}
.member-pager-info {
  font-size: 13px;
  color: #606266;
}
</style>
