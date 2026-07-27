/**
 * Shared WeChat globals test harness.
 *
 * Mini-program pages register themselves via the global `Page({...})` call at
 * module load time, and call `wx.*` APIs at runtime. Vitest runs in Node, so
 * each test must (a) install a capturing `Page`/`App` global BEFORE importing
 * the page module, and (b) provide a controllable `wx` mock with an in-memory
 * storage shim. `vi.resetModules()` is used so the page module re-runs its
 * top-level `Page({...})` against the fresh capture every time.
 */
// Input shape accepted by the capturing `Page()`/`Component()` globals: data
// is optional because some configs construct it lazily.
type InputConfig = Record<string, (...args: unknown[]) => unknown> & {
  data?: Record<string, unknown>;
};

// Captured shape: `ensureSetData` always installs a `data` object before
// capture, so this is declared required (not `data?`) to save every spec from
// a non-null assert on `page.data`.
type PageConfig = Record<string, (...args: unknown[]) => unknown> & {
  data: Record<string, unknown>;
};

/**
 * Captured `Component({...})` config. Mirrors {@link PageConfig}; lifecycle
 * methods (`attached`, `detached`) and event handlers are captured here so a
 * component test can drive them against an in-memory instance. `setData` is
 * auto-installed to merge into `data`, matching the page capture behaviour.
 */
type ComponentConfig = Record<string, (...args: unknown[]) => unknown> & {
  data: Record<string, unknown>;
  properties?: Record<string, unknown>;
};

export interface WxMock {
  storage: Record<string, unknown>;
  captured: {
    page: PageConfig | null;
    app: unknown | null;
    component: ComponentConfig | null;
  };
  wx: {
    setStorageSync: ReturnType<typeof vi.fn>;
    getStorageSync: ReturnType<typeof vi.fn>;
    removeStorageSync: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    checkSession: ReturnType<typeof vi.fn>;
    navigateTo: ReturnType<typeof vi.fn>;
    redirectTo: ReturnType<typeof vi.fn>;
    reLaunch: ReturnType<typeof vi.fn>;
    switchTab: ReturnType<typeof vi.fn>;
    navigateBack: ReturnType<typeof vi.fn>;
    showToast: ReturnType<typeof vi.fn>;
    showLoading: ReturnType<typeof vi.fn>;
    hideLoading: ReturnType<typeof vi.fn>;
  };
}

/**
 * Install fresh `Page`/`App`/`wx` globals and return handles to the capture
 * slots and the wx mock functions. Call `vi.resetModules()` separately before
 * importing the page under test.
 */
export function installWxGlobals(): WxMock {
  const storage: Record<string, unknown> = {};
  const captured: WxMock['captured'] = {
    page: null,
    app: null,
    component: null,
  };

  // Install a default no-op `setData` so pages/components that call
  // `this.setData` during lifecycle hooks work even when a test doesn't
  // override it with a spy. Tests that assert on setData replace this.
  function ensureSetData(instance: { setData?: unknown; data?: unknown }): void {
    if (typeof instance.setData !== 'function') {
      instance.setData = (data: Record<string, unknown>) => {
        Object.assign((instance.data ??= {}), data);
      };
    }
  }

  (globalThis as { Page?: unknown }).Page = (config: InputConfig): void => {
    ensureSetData(config as { setData?: unknown; data?: unknown });
    captured.page = config as PageConfig;
  };
  (globalThis as { App?: unknown }).App = (config: unknown): void => {
    captured.app = config;
  };
  (globalThis as { Component?: unknown }).Component = (
    config: InputConfig,
  ): void => {
    ensureSetData(config as { setData?: unknown; data?: unknown });
    // WeChat hoists `methods.*` onto the component instance; mirror that so
    // tests can call e.g. `component.onPickStudent(...)` directly.
    const methods = (config as { methods?: Record<string, unknown> }).methods;
    if (methods && typeof methods === 'object') {
      for (const [name, fn] of Object.entries(methods)) {
        if (typeof fn === 'function' && !(name in config)) {
          (config as Record<string, unknown>)[name] = fn;
        }
      }
    }
    captured.component = config as ComponentConfig;
  };

  const wx: WxMock['wx'] = {
    setStorageSync: vi.fn((key: string, value: unknown) => {
      storage[key] = value;
    }),
    getStorageSync: vi.fn((key: string) => storage[key] ?? ''),
    removeStorageSync: vi.fn((key: string) => {
      delete storage[key];
    }),
    request: vi.fn(),
    login: vi.fn(),
    checkSession: vi.fn(),
    navigateTo: vi.fn(),
    redirectTo: vi.fn(),
    reLaunch: vi.fn(),
    switchTab: vi.fn(),
    navigateBack: vi.fn(),
    showToast: vi.fn(),
    showLoading: vi.fn(),
    hideLoading: vi.fn(),
  };
  (globalThis as { wx?: unknown }).wx = wx;

  return { storage, captured, wx };
}

/** Clear storage + all mock call history. Call in `beforeEach` after install. */
export function resetWxMock(mock: WxMock): void {
  for (const key of Object.keys(mock.storage)) {
    delete mock.storage[key];
  }
  mock.captured.page = null;
  mock.captured.app = null;
  mock.captured.component = null;
  Object.values(mock.wx).forEach((fn) => fn.mockClear());
}

/**
 * Resolve a `wx.request` mock to a canned response. The page wrapper uses the
 * success/error callbacks (or promise) — wire both shapes so tests can pick.
 */
export function respondOk(
  mock: WxMock,
  body: unknown,
  statusCode = 200,
): void {
  mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
    const res = { statusCode, data: body, header: {}, cookies: [] };
    if (typeof opts.success === 'function') {
      opts.success(res);
    }
    return Promise.resolve(res);
  });
}

/** Build a canonical API success body. */
export function apiOk<T>(data: T): { code: number; data: T; message: string } {
  return { code: 0, data, message: 'ok' };
}

/** Build a canonical API error body, preserving a trace id. */
export function apiError(
  code: string,
  message: string,
  traceId = 'trace-1',
  details?: Record<string, unknown>,
): {
  code: string;
  message: string;
  traceId: string;
  details?: Record<string, unknown>;
} {
  return details ? { code, message, traceId, details } : { code, message, traceId };
}
