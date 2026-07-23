import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('courses page empty state', () => {
  it('shows the no-courses empty-state copy', () => {
    const wxml = readFileSync(
      new URL('../../miniprogram/pages/courses/index.wxml', import.meta.url),
      'utf8',
    );
    expect(wxml).toContain('暂无已上架课程');
  });

  it('renders an empty list when courses array is empty', () => {
    const wxml = readFileSync(
      new URL('../../miniprogram/pages/courses/index.wxml', import.meta.url),
      'utf8',
    );
    expect(wxml).toContain('wx:if="{{courses.length > 0}}"');
    expect(wxml).toContain('wx:else');
  });
});
