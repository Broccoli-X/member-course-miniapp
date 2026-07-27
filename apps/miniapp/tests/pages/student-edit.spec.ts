import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// student-edit page: create or edit a related student (SELF / GUARDIAN).
// Fields: relationship, displayName, optional birthDate.
// ────────────────────────────────────────────────────────────────────────────

describe('student-edit page', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
    mock.storage['member-course:refresh-token'] = 'refresh-jwt';
  });

  it('defaults to create mode with SELF relationship when no id is provided', async () => {
    const setData = vi.fn();
    await import('../../miniprogram/pages/student-edit/index');
    const page = mock.captured.page!;
    page.setData = setData;
    await page.onLoad();

    expect(setData).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'create', relationship: 'SELF' }),
    );
  });

  it('enters edit mode and loads the existing student when an id is provided', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/students/student-a')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              student: { id: 'student-a', displayName: 'Alice', birthDate: '2018-01-01' },
              relation: { id: 'rel-1', relationType: 'GUARDIAN' },
            },
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    const setData = vi.fn();
    await import('../../miniprogram/pages/student-edit/index');
    const page = mock.captured.page!;
    page.setData = setData;
    await page.onLoad({ id: 'student-a' });

    expect(setData).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'edit',
        studentId: 'student-a',
        displayName: 'Alice',
        relationship: 'GUARDIAN',
      }),
    );
  });

  it('creates a student via POST and navigates back on success', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (
        String(opts.method || 'GET').toUpperCase() === 'POST' &&
        String(opts.url).endsWith('/api/mini/v1/students')
      ) {
        expect(opts.data).toEqual({
          displayName: 'Charlie',
          birthDate: null,
          relationship: 'GUARDIAN',
        });
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              student: { id: 'student-c', displayName: 'Charlie', birthDate: null },
              relation: { id: 'rel-c', relationType: 'GUARDIAN' },
            },
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/student-edit/index');
    const page = mock.captured.page!;
    await page.onLoad();
    page.onDisplayNameInput({ detail: { value: 'Charlie' } });
    page.onRelationshipChange({ detail: { value: 'GUARDIAN' } });

    await page.onSave();

    expect(mock.wx.navigateBack).toHaveBeenCalled();
  });

  it('patches an existing student via PATCH in edit mode', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      const url = String(opts.url);
      if (url.endsWith('/api/mini/v1/students/student-a')) {
        const method = String(opts.method || 'GET').toUpperCase();
        if (method === 'GET') {
          const res = {
            statusCode: 200,
            data: {
              code: 0,
              message: 'ok',
              data: {
                student: { id: 'student-a', displayName: 'Alice', birthDate: '2018-01-01' },
                relation: { id: 'rel-1', relationType: 'GUARDIAN' },
              },
            },
            header: {},
            cookies: [],
          };
          if (typeof opts.success === 'function') opts.success(res);
        } else if (method === 'PATCH') {
          expect(opts.data).toEqual({ displayName: 'Alicia', birthDate: '2018-01-01' });
          const res = {
            statusCode: 200,
            data: {
              code: 0,
              message: 'ok',
              data: {
                student: { id: 'student-a', displayName: 'Alicia', birthDate: '2018-01-01' },
                relation: { id: 'rel-1', relationType: 'GUARDIAN' },
              },
            },
            header: {},
            cookies: [],
          };
          if (typeof opts.success === 'function') opts.success(res);
        }
      }
      return {};
    });

    await import('../../miniprogram/pages/student-edit/index');
    const page = mock.captured.page!;
    await page.onLoad({ id: 'student-a' });
    page.onDisplayNameInput({ detail: { value: 'Alicia' } });

    await page.onSave();

    const patchCall = mock.wx.request.mock.calls.find(
      (c) =>
        String(c[0].url).endsWith('/api/mini/v1/students/student-a') &&
        String(c[0].method || 'GET').toUpperCase() === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    expect(mock.wx.navigateBack).toHaveBeenCalled();
  });

  it('rejects an empty display name with a toast', async () => {
    await import('../../miniprogram/pages/student-edit/index');
    const page = mock.captured.page!;
    await page.onLoad();
    page.onDisplayNameInput({ detail: { value: '   ' } });

    await page.onSave();

    expect(mock.wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String) }),
    );
    expect(mock.wx.request).not.toHaveBeenCalled();
  });

  it('never sends relationship in a PATCH (relationship is immutable post-create)', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      const url = String(opts.url);
      if (url.endsWith('/api/mini/v1/students/student-a')) {
        const method = String(opts.method || 'GET').toUpperCase();
        if (method === 'GET') {
          const res = {
            statusCode: 200,
            data: {
              code: 0,
              message: 'ok',
              data: {
                student: { id: 'student-a', displayName: 'Alice', birthDate: '2018-01-01' },
                relation: { id: 'rel-1', relationType: 'GUARDIAN' },
              },
            },
            header: {},
            cookies: [],
          };
          if (typeof opts.success === 'function') opts.success(res);
        } else if (method === 'PATCH') {
          const res = {
            statusCode: 200,
            data: {
              code: 0,
              message: 'ok',
              data: {
                student: { id: 'student-a', displayName: 'Alice', birthDate: '2018-01-01' },
                relation: { id: 'rel-1', relationType: 'GUARDIAN' },
              },
            },
            header: {},
            cookies: [],
          };
          if (typeof opts.success === 'function') opts.success(res);
        }
      }
      return {};
    });

    await import('../../miniprogram/pages/student-edit/index');
    const page = mock.captured.page!;
    await page.onLoad({ id: 'student-a' });
    await page.onSave();

    const patchCall = mock.wx.request.mock.calls.find(
      (c) =>
        String(c[0].url).endsWith('/api/mini/v1/students/student-a') &&
        String(c[0].method || 'GET').toUpperCase() === 'PATCH',
    );
    const body = patchCall![0].data as Record<string, unknown>;
    expect(body.relationship).toBeUndefined();
  });
});
