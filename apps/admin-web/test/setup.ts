/**
 * Vitest global setup.
 *
 * Mocks the imperative Element Plus services (`ElMessage`, `ElMessageBox`,
 * `ElNotification`) which rely on Teleport + transitions jsdom can't drive,
 * while keeping the real component plugin available. The real plugin is
 * registered globally up-front (not inside the `vi.mock` factory) so that
 * components which only type-import from `element-plus` (e.g. StudentForm,
 * PackageProductForm) still resolve `el-form` / `el-input` / `el-table` and
 * run real validation in tests.
 *
 * Also wraps `vue-router`'s `createRouter` to work around a jsdom timing bug:
 * when a test calls `router.push('/some/path')` and then `mount()`s a
 * component without awaiting the push, vue-router's `install()` (triggered by
 * mount) issues its OWN `push(routerHistory.location)` to `'/'` because
 * `currentRoute.value` is still the START location at install time. That
 * second navigation CANCELS the test's pending `/some/path` navigation, so
 * components never see their route params. The wrapper remembers the last
 * push target and, if install's cancel actually displaced it, re-navigates
 * after install so `useRoute()` resolves the intended params.
 */
import { config } from '@vue/test-utils';
import { vi } from 'vitest';
import ElementPlus from 'element-plus';

// Register the REAL Element Plus plugin once, globally, for every test file.
// This must NOT depend on the `vi.mock` factory below being triggered by a
// runtime import — several components only `import type` from element-plus.
if (!config.global.plugins.includes(ElementPlus)) {
  config.global.plugins.push(ElementPlus);
}

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  const origCreateRouter = actual.createRouter;
  const wrappedCreateRouter = function patchedCreateRouter(this: unknown, opts: Parameters<typeof origCreateRouter>[0]) {
    const router = origCreateRouter(opts);
    let lastTarget: string | { path?: string } | null = null;
    const origPush = router.push.bind(router);
    (router as unknown as { push: unknown }).push = function push(to: string | { path?: string }) {
      lastTarget = to;
      return origPush(to as never);
    };
    const origInstall = (router as unknown as { install: (app: unknown) => void }).install.bind(router);
    (router as unknown as { install: (app: unknown) => void }).install = function install(app: unknown) {
      origInstall(app);
      const targetPath = typeof lastTarget === 'string' ? lastTarget : lastTarget?.path ?? null;
      // Only re-navigate when install's auto-`push('/')` displaced a real
      // intended target (i.e. a non-root path that didn't take effect).
      if (targetPath && targetPath !== '/' && router.currentRoute.value.fullPath !== targetPath) {
        void origPush(lastTarget as never);
      }
    };
    return router;
  };
  return { ...actual, createRouter: wrappedCreateRouter as typeof origCreateRouter };
});

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>();
  return {
    ...actual,
    ElMessage: Object.assign(vi.fn(), {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
      close: vi.fn(),
      closeAll: vi.fn(),
    }),
    ElMessageBox: {
      confirm: vi.fn(async () => 'confirm'),
      alert: vi.fn(async () => 'confirm'),
      prompt: vi.fn(async () => ({ value: '', action: 'confirm' })),
      close: vi.fn(),
    },
    ElNotification: Object.assign(vi.fn(), {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
      close: vi.fn(),
      closeAll: vi.fn(),
    }),
  };
});
