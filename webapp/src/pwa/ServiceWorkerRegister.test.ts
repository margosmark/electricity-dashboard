import { describe, expect, it } from 'vitest';
import { shouldWarmRateCache } from './ServiceWorkerRegister';

describe('service-worker rate cache warmup', () => {
  it('skips rate warmup for a fresh browser without household readings', () => {
    expect(shouldWarmRateCache({ getItem: () => null })).toBe(false);
  });

  it('warms the rate cache when saved household readings exist', () => {
    expect(shouldWarmRateCache({ getItem: (key) => key === 'energy_data_v2' ? '{"points":[]}' : null })).toBe(true);
  });
});
