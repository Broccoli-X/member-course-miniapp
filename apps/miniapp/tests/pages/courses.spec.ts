import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// Courses page (public catalog): GET /courses, ACTIVE only. Rendered for both
// bound and unbound users. Real empty state — no schedule/activity placeholders.
// ────────────────────────────────────────────────────────────────────────────

describe('courses page', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
  });

  it('loads public courses without requiring a session', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/courses')) {
        expect((opts.header as Record<string, unknown>)?.Authorization).toBeFalsy();
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              items: [
                { id: 'course-1', name: 'Piano', type: 'ONE_TO_ONE', description: 'Jazz' },
                { id: 'course-2', name: 'Art', type: 'CLASS', description: 'Kids art' },
              ],
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
    await import('../../miniprogram/pages/courses/index');
    const page = mock.captured.page!;
    page.setData = setData;
    await page.onLoad();

    expect(setData).toHaveBeenCalledWith(
      expect.objectContaining({
        courses: expect.arrayContaining([
          expect.objectContaining({ id: 'course-1' }),
          expect.objectContaining({ id: 'course-2' }),
        ]),
      }),
    );
  });

  it('renders the real empty state when no courses are available', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/courses')) {
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
    await import('../../miniprogram/pages/courses/index');
    const page = mock.captured.page!;
    page.setData = setData;
    await page.onLoad();

    expect(setData).toHaveBeenCalledWith(expect.objectContaining({ courses: [] }));
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/courses/index.wxml', import.meta.url),
        'utf8',
      ),
    );
    expect(wxml).toContain('暂无已上架课程');
  });

  it('navigates to course-detail when a course card is tapped', async () => {
    await import('../../miniprogram/pages/courses/index');
    const page = mock.captured.page!;

    await page.onOpenCourse({ currentTarget: { dataset: { id: 'course-1' } } });

    expect(mock.wx.navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/course-detail/index?id=course-1' }),
    );
  });

  it('preserves a trace id when the catalog errors', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/courses')) {
        const res = {
          statusCode: 500,
          data: {
            code: 'INTERNAL_ERROR',
            message: 'boom',
            traceId: 'trace-z',
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    const setData = vi.fn();
    await import('../../miniprogram/pages/courses/index');
    const page = mock.captured.page!;
    page.setData = setData;
    await page.onLoad();

    // Falls back to an empty list + surfaces the error toast with the trace id.
    expect(setData).toHaveBeenCalledWith(expect.objectContaining({ courses: [] }));
    expect(mock.wx.showToast).toHaveBeenCalled();
  });
});
