import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('my page empty state', () => {
  it('shows the bind-phone-to-view-assets copy', () => {
    const wxml = readFileSync(
      new URL('../../miniprogram/pages/my/index.wxml', import.meta.url),
      'utf8',
    );
    expect(wxml).toContain('绑定手机号后查看会员资产');
  });
});
