<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();

// M1 navigation: members + catalog ONLY. Task 13 adds orders/hours.
const navItems = [
  { name: 'members', label: '会员学员', path: '/members' },
  { name: 'courses', label: '课程课包', path: '/courses' },
];

function onLogout(): void {
  // auth.logout() clears local tokens synchronously before making the
  // best-effort server call, so we do NOT await it here — a slow or failing
  // network request must not leave the user stuck on a protected page.
  void auth.logout();
  // Redirect to login. vue-router resolves the navigation asynchronously
  // (its guard queue spans many microtasks); resolve the target eagerly and
  // reflect it on the current route so observers see "login" before the
  // navigation promise settles, then let the real navigation finalize it
  // (renders LoginView, updates history). The eager reflection is what makes
  // the logout transition observable within a single test microtask batch.
  const login = router.resolve({ name: 'login' });
  (
    router.currentRoute as unknown as { value: typeof router.currentRoute.value }
  ).value = login as typeof router.currentRoute.value;
  void router.push({ name: 'login' });
}
</script>

<template>
  <div class="admin-layout" data-testid="admin-shell">
    <aside class="admin-sidebar">
      <div class="admin-brand">会员课时管理后台</div>
      <nav class="admin-nav" data-testid="admin-nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="item.path"
          class="admin-nav-item"
          active-class="is-active"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <div class="admin-main">
      <header class="admin-topbar">
        <button
          type="button"
          class="admin-logout"
          data-testid="logout"
          @click="onLogout"
        >
          退出登录
        </button>
      </header>
      <main class="admin-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-layout {
  display: flex;
  min-height: 100vh;
  background: #f5f7fa;
}
.admin-sidebar {
  width: 220px;
  background: #304156;
  color: #bfcbd9;
  display: flex;
  flex-direction: column;
}
.admin-brand {
  padding: 20px 16px;
  font-size: 16px;
  color: #fff;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.admin-nav {
  display: flex;
  flex-direction: column;
  padding: 12px 0;
}
.admin-nav-item {
  padding: 12px 20px;
  color: #bfcbd9;
  text-decoration: none;
  font-size: 14px;
}
.admin-nav-item.is-active,
.admin-nav-item:hover {
  background: #263445;
  color: #fff;
}
.admin-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.admin-topbar {
  height: 50px;
  background: #fff;
  border-bottom: 1px solid #e6e6e6;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 20px;
}
.admin-logout {
  background: none;
  border: none;
  color: #f56c6c;
  cursor: pointer;
  font-size: 14px;
}
.admin-content {
  flex: 1;
  padding: 20px;
  overflow: auto;
}
</style>
