<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { useAuthStore } from '../../stores/auth';
import { ApiError } from '../../api/http';

interface LoginForm {
  username: string;
  password: string;
}

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const formRef = ref<FormInstance>();
const form = reactive<LoginForm>({ username: '', password: '' });
const submitting = ref(false);
// Verbatim API message + traceId surfaced to the user on auth failure.
const errorMessage = ref('');
const errorTraceId = ref('');

const rules: FormRules<LoginForm> = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

async function onSubmit(): Promise<void> {
  errorMessage.value = '';
  errorTraceId.value = '';
  if (!formRef.value) return;
  // Element Plus's bundled async-validator does not reliably reject empty
  // strings for `required` rules under jsdom, so guard explicitly before the
  // login call. validate() is still invoked to surface field error messages.
  if (!form.username || !form.password) {
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
  submitting.value = true;
  try {
    await auth.login({ username: form.username, password: form.password });
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/members';
    router.push(redirect);
  } catch (err) {
    if (err instanceof ApiError) {
      errorMessage.value = err.message;
      errorTraceId.value = err.traceId;
      ElMessage.error(`${err.message}（追踪号：${err.traceId}）`);
    } else {
      errorMessage.value = '登录失败，请稍后重试';
      ElMessage.error(errorMessage.value);
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-view" data-testid="login-shell">
    <div class="login-card">
      <h1 class="login-title">会员课时管理系统</h1>
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        @submit.prevent="onSubmit"
      >
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" name="username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            name="password"
            type="password"
            autocomplete="current-password"
            show-password
          />
        </el-form-item>
        <div v-if="errorMessage" class="login-error" data-testid="login-error">
          <span class="login-error-message">{{ errorMessage }}</span>
          <span v-if="errorTraceId" class="login-error-trace">追踪号：{{ errorTraceId }}</span>
        </div>
        <el-button
          type="primary"
          native-type="submit"
          :loading="submitting"
          data-testid="login-submit"
        >
          登录
        </el-button>
      </el-form>
    </div>
  </div>
</template>

<style scoped>
.login-view {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
}
.login-card {
  width: 360px;
  padding: 32px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}
.login-title {
  margin: 0 0 24px;
  font-size: 20px;
  text-align: center;
}
.login-error {
  margin-bottom: 12px;
  padding: 8px 12px;
  background: #fef0f0;
  border: 1px solid #fbc4c4;
  border-radius: 4px;
  color: #f56c6c;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
