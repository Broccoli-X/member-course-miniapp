import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('miniapp bootstrap', () => {
  it('declares the initial course and profile pages', () => {
    const config = JSON.parse(
      readFileSync(new URL('../miniprogram/app.json', import.meta.url), 'utf8'),
    ) as { pages: string[] };
    expect(config.pages).toEqual(['pages/courses/index', 'pages/my/index']);
  });
});
