import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('miniapp bootstrap', () => {
  it('declares the initial course and profile pages', () => {
    const config = JSON.parse(
      readFileSync(new URL('../miniprogram/app.json', import.meta.url), 'utf8'),
    ) as { pages: string[] };
    expect(config.pages).toEqual([
      'pages/courses/index',
      'pages/course-detail/index',
      'pages/login/index',
      'pages/bind-phone/index',
      'pages/students/index',
      'pages/student-edit/index',
      'pages/my/index',
    ]);
  });
});
