import type { Plan, Step } from '../types.js';
import { EDGE_CASES, edgeCaseById } from './edgeCases.js';
import { DEFAULT_FLEET, generateRealistic } from './realistic.js';
import { randomSeed } from './rng.js';
import { loadSamples, sampleSteps } from './samples.js';

export interface ScenarioInfo {
  id: string;
  label: string;
  group: 'Fleet' | 'Samples' | 'Edge cases' | 'Suite';
  description: string;
  countMeaning: 'readings' | 'samples' | 'instances' | 'batch size' | 'ignored';
  defaultCount: number;
  maxCount: number;
}

export const MAX_REALISTIC = 200;

export function listScenarios(): ScenarioInfo[] {
  return [
    {
      id: 'realistic',
      label: 'Realistic fleet',
      group: 'Fleet',
      description: `${DEFAULT_FLEET.length} trucks on real lanes (Pharr TX to Bronx NY, Memphis to Chicago, Durham to Boston). 2-8 C with noise, a possible excursion, battery drain, mixed GPS, WiFi and cell fixes, 15 minutes apart.`,
      countMeaning: 'readings',
      defaultCount: 20,
      maxCount: MAX_REALISTIC,
    },
    {
      id: 'samples',
      label: 'Provided samples',
      group: 'Samples',
      description: 'The payloads from sample-tive-payloads.json, one by one, each with its expected outcome.',
      countMeaning: 'samples',
      defaultCount: loadSamples().length,
      maxCount: loadSamples().length,
    },
    ...EDGE_CASES.map<ScenarioInfo>((c) => ({
      id: c.id,
      label: c.label,
      group: 'Edge cases',
      description: `${c.description} Breaks: ${c.rule}.`,
      countMeaning: c.countMeaning,
      defaultCount: c.defaultCount,
      maxCount: c.maxCount,
    })),
    {
      id: 'edge-suite',
      label: 'All edge cases',
      group: 'Suite',
      description: 'One instance of every edge case (batch of 5). A quick contract check of the API.',
      countMeaning: 'ignored',
      defaultCount: 1,
      maxCount: 1,
    },
  ];
}

export interface BuildOptions {
  count?: number;
  seed?: number;
  now?: number;
}

export class UnknownScenarioError extends Error {}

export function buildPlan(scenario: string, opts: BuildOptions = {}): Plan {
  const info = listScenarios().find((s) => s.id === scenario);
  if (!info) throw new UnknownScenarioError(`Unknown scenario: ${scenario}`);
  const seed = (opts.seed ?? randomSeed()) >>> 0;
  const now = opts.now ?? Date.now();
  const count = clampCount(opts.count ?? info.defaultCount, info.maxCount);

  let steps: Step[];
  if (scenario === 'realistic') {
    const { payloads, excursion } = generateRealistic({ count, seed, now });
    steps = payloads.map((p, i) => {
      const inExcursion = excursion?.indexes.includes(i) ?? false;
      return {
        label: `${p.DeviceName} ${p.Location.FormattedAddress ?? ''}${inExcursion ? ' (excursion)' : ''}`.trim(),
        body: JSON.stringify(p),
        payload: p,
        contentType: 'application/json',
        auth: 'default',
        imei: p.DeviceId,
        expect: {
          httpStatus: [201],
          apiStatus: ['processed'],
          note: inExcursion ? `Temperature excursion, ${p.Temperature.Celsius} C` : 'Valid reading',
        },
      };
    });
  } else if (scenario === 'samples') {
    steps = sampleSteps(count);
  } else {
    const caseSeed = (seed ^ hashString(scenario)) >>> 0;
    if (scenario === 'edge-suite') {
      steps = EDGE_CASES.flatMap((c) => c.build({ seed: caseSeed, now, index: 0, batchSize: 5 }).steps);
    } else {
      const edge = edgeCaseById(scenario)!;
      steps =
        edge.countMeaning === 'batch size'
          ? edge.build({ seed: caseSeed, now, index: 0, batchSize: count }).steps
          : Array.from({ length: count }, (_, index) => edge.build({ seed: caseSeed, now, index, batchSize: 0 }).steps).flat();
    }
  }
  return { scenario, seed, steps };
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function clampCount(count: number, max: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.min(max, Math.max(1, Math.floor(count)));
}
