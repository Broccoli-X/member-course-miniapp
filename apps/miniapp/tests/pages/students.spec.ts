import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// Students page: lists the bound member's related students (GET /students),
// lets the member pick one (current-student-store), and offers an "add
// student" entry that routes to student-edit.
// ────────────────────────────────────────────────────────────────────────────

const STUDENTS = [
  {
    student: { id: 'student-a', displayName: 'Alice', birthDate: '2018-01-01' },
    relation: { id: 'rel-1', accountId: 'acc-1', studentId: 'student-a', relationType: 'GUARDIAN' },
  },
  {
    student: { id: 'student-b', displayName: 'Bob', birthDate: '2016-05-05' },
    relation: { id: 'rel-2', accountId: 'acc-1', studentId: 'student-b', relationType: 'GUARDIAN' },
  },
];

describe('students page', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
    // Pretend we're already bound so the http layer attaches the bearer.
    mock.storage['member-course:refresh-token'] = 'refresh-jwt';
  });

  function stubStudentsResponse() {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/students')) {
        const res = {
          statusCode: 200,
          data: { code: 0, message: 'ok', data: { items: STUDENTS } },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });
  }

  it('loads and renders the related students list', async () => {
    stubStudentsResponse();

    const setData = vi.fn();
    await import('../../miniprogram/pages/students/index');
    const page = mock.captured.page!;
    // Bind the page instance's setData onto our spy.
    page.setData = setData;
    await page.onLoad();

    expect(setData).toHaveBeenCalledWith(
      expect.objectContaining({
        students: expect.arrayContaining([
          expect.objectContaining({ id: 'student-a' }),
          expect.objectContaining({ id: 'student-b' }),
        ]),
      }),
    );
  });

  it('shows the real empty state when the member has no students', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/students')) {
        const res = {
          statusCode: 200,
          data: { code: 0, message: 'ok', data: { items: [] } },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    const setData = vi.fn();
    await import('../../miniprogram/pages/students/index');
    const page = mock.captured.page!;
    page.setData = setData;
    await page.onLoad();

    expect(setData).toHaveBeenCalledWith(expect.objectContaining({ students: [] }));
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/students/index.wxml', import.meta.url),
        'utf8',
      ),
    );
    expect(wxml).toContain('暂无学员');
    expect(wxml).not.toContain('课表');
    expect(wxml).not.toContain('活动');
  });

  it('selecting a student updates the current-student store', async () => {
    stubStudentsResponse();

    await import('../../miniprogram/pages/students/index');
    const page = mock.captured.page!;
    await page.onLoad();

    await page.onSelectStudent({ currentTarget: { dataset: { id: 'student-b' } } });

    const { currentStudentStore } = await import(
      '../../miniprogram/stores/current-student-store'
    );
    expect(currentStudentStore.currentId).toBe('student-b');
  });

  it('"add student" navigates to student-edit in create mode', async () => {
    await import('../../miniprogram/pages/students/index');
    const page = mock.captured.page!;

    await page.onAddStudent();

    expect(mock.wx.navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/student-edit/index' }),
    );
  });

  it('edits an existing student by navigating to student-edit with the id', async () => {
    await import('../../miniprogram/pages/students/index');
    const page = mock.captured.page!;

    await page.onEditStudent({ currentTarget: { dataset: { id: 'student-a' } } });

    expect(mock.wx.navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/student-edit/index?id=student-a' }),
    );
  });
});
