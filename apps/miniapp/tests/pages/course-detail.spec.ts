import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// Course-detail page (public): GET /courses/:id. Renders the course and its
// package products. Public — no auth required.
// ────────────────────────────────────────────────────────────────────────────

describe('course-detail page', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
  });

  it('loads a course with its packages for an unbound visitor', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/courses/course-1')) {
        expect((opts.header as Record<string, unknown>)?.Authorization).toBeFalsy();
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              course: { id: 'course-1', name: 'Piano', type: 'ONE_TO_ONE', description: 'Jazz' },
              packages: [
                {
                  id: 'pkg-1',
                  courseId: 'course-1',
                  name: '10 lessons',
                  price: '1000.00',
                  hours: '10.00',
                  validDays: 90,
                },
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
    await import('../../miniprogram/pages/course-detail/index');
    const page = mock.captured.page!;
    page.setData = setData;
    await page.onLoad({ id: 'course-1' });

    expect(setData).toHaveBeenCalledWith(
      expect.objectContaining({
        course: expect.objectContaining({ id: 'course-1' }),
        packages: expect.arrayContaining([expect.objectContaining({ id: 'pkg-1' })]),
      }),
    );
  });

  it('shows the not-found empty state when the course is missing', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/courses/missing')) {
        const res = {
          statusCode: 404,
          data: { code: 'RESOURCE_NOT_FOUND', message: 'no such course', traceId: 'trace-n' },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    const setData = vi.fn();
    await import('../../miniprogram/pages/course-detail/index');
    const page = mock.captured.page!;
    page.setData = setData;
    await page.onLoad({ id: 'missing' });

    expect(setData).toHaveBeenCalledWith(expect.objectContaining({ notFound: true }));
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/course-detail/index.wxml', import.meta.url),
        'utf8',
      ),
    );
    expect(wxml).toContain('课程不存在或已下架');
  });

  it('renders price and hours as decimal strings (no JS number math)', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/courses/course-1')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              course: { id: 'course-1', name: 'Piano', type: 'ONE_TO_ONE', description: 'Jazz' },
              packages: [
                {
                  id: 'pkg-1',
                  courseId: 'course-1',
                  name: '10 lessons',
                  price: '1000.00',
                  hours: '10.00',
                  validDays: 90,
                },
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
    await import('../../miniprogram/pages/course-detail/index');
    const page = mock.captured.page!;
    page.setData = setData;
    await page.onLoad({ id: 'course-1' });

    const packages = setData.mock.calls.find(
      (c) => (c[0] as { packages?: unknown[] }).packages,
    )?.[0]?.packages as Array<{ price: string; hours: string }>;
    expect(packages[0].price).toBe('1000.00');
    expect(packages[0].hours).toBe('10.00');
  });
});
