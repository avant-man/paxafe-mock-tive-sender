/**
 * Contract check against a real Integration API. Skipped unless both are set:
 *   LIVE_TARGET_URL=http://localhost:3000 LIVE_TARGET_KEY=... npm test -- contract.live
 * Every scenario runs once and every result must match its expected outcome. Works with
 * an unscoped key and with a key scoped to the demo account (478).
 */
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/config.js';
import { buildPlan, listScenarios } from '../src/generators/index.js';
import { runPlan } from '../src/sender.js';

const url = process.env['LIVE_TARGET_URL'];
const key = process.env['LIVE_TARGET_KEY'];
const live = Boolean(url && key);

describe.skipIf(!live)(`live contract against ${url ?? '(LIVE_TARGET_URL not set)'}`, () => {
  for (const s of listScenarios()) {
    it(s.id, { timeout: 120_000 }, async () => {
      const count = s.countMeaning === 'batch size' ? 10 : s.countMeaning === 'ignored' ? undefined : Math.min(3, s.maxCount);
      const plan = buildPlan(s.id, { count: s.id === 'samples' ? undefined : count });
      const run = await runPlan(plan, { url: normalizeUrl(url!), apiKey: key! }, { timeoutMs: 90_000 });
      const bad = run.results.filter((r) => !r.matched).map((r) => `${r.label}: ${r.mismatch}`);
      expect(bad, `${s.id} seed ${run.seed}`).toEqual([]);
    });
  }
});
