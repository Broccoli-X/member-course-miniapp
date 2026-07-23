import { describe, it, expect } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('returns API health', () => {
    expect(new HealthController().getHealth()).toEqual({ status: 'ok' });
  });
});
