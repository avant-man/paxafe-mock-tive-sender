import { describe, expect, it } from 'vitest';
import { buildPlan, listScenarios } from '../src/generators/index.js';
import { DEFAULT_FLEET, DEMO_ACCOUNT_ID, generateRealistic } from '../src/generators/realistic.js';
import { createRng } from '../src/generators/rng.js';
import { loadSamples } from '../src/generators/samples.js';
import { schemaErrorPaths, validateTive } from './support/tiveSchema.js';

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
  });
});

describe('realistic generator', () => {
  it('produces schema-valid payloads for many seeds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { payloads } = generateRealistic({ count: 40, seed, now: NOW });
      for (const p of payloads) {
        expect(schemaErrorPaths(p), `seed ${seed} ${JSON.stringify(p)}`).toEqual([]);
      }
    }
  });

  it('is stable for a fixed seed and now', () => {
    const a = generateRealistic({ count: 12, seed: 1234, now: NOW });
    const b = generateRealistic({ count: 12, seed: 1234, now: NOW });
    expect(a).toEqual(b);
    expect(
      a.payloads.slice(0, 3).map((p) => ({
        id: p.DeviceId,
        t: p.EntryTimeEpoch,
        c: p.Temperature.Celsius,
        lat: p.Location.Latitude,
        m: p.Location.LocationMethod,
        b: p.Battery?.Percentage,
      })),
    ).toMatchSnapshot();
  });

  it('gives different readings for different seeds', () => {
    const a = generateRealistic({ count: 6, seed: 1, now: NOW }).payloads.map((p) => p.Temperature.Celsius);
    const b = generateRealistic({ count: 6, seed: 2, now: NOW }).payloads.map((p) => p.Temperature.Celsius);
    expect(a).not.toEqual(b);
  });

  it('spaces readings 15 minutes apart per device and ends at now', () => {
    const { payloads } = generateRealistic({ count: 30, seed: 7, now: NOW });
    for (const device of DEFAULT_FLEET) {
      const ts = payloads.filter((p) => p.DeviceId === device.imei).map((p) => p.EntryTimeEpoch);
      expect(ts.length).toBe(10);
      for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBe(15 * 60_000);
      expect(ts[ts.length - 1]!).toBeLessThanOrEqual(NOW);
      expect(NOW - ts[ts.length - 1]!).toBeLessThan(5 * 60_000);
    }
  });

  it('keeps every key unique, so a run never duplicates itself', () => {
    const { payloads } = generateRealistic({ count: 200, seed: 99, now: NOW });
    const keys = new Set(payloads.map((p) => `${p.DeviceId}:${p.EntryTimeEpoch}`));
    expect(keys.size).toBe(200);
  });

  it('keeps temperature in 2-8 C without an excursion', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { payloads, excursion } = generateRealistic({ count: 60, seed, now: NOW, excursion: false });
      expect(excursion).toBeNull();
      for (const p of payloads) {
        expect(p.Temperature.Celsius).toBeGreaterThanOrEqual(2);
        expect(p.Temperature.Celsius).toBeLessThanOrEqual(8);
        expect(p.Temperature.Fahrenheit).toBeCloseTo((p.Temperature.Celsius! * 9) / 5 + 32, 5);
      }
    }
  });

  it('adds an excursion above 8 C when asked', () => {
    const { payloads, excursion } = generateRealistic({ count: 30, seed: 3, now: NOW, excursion: true });
    expect(excursion).not.toBeNull();
    expect(excursion!.peakCelsius).toBeGreaterThan(8);
    for (const i of excursion!.indexes) expect(payloads[i]!.DeviceId).toBe(excursion!.imei);
  });

  it('drains the battery and never charges it', () => {
    const { payloads } = generateRealistic({ count: 90, seed: 11, now: NOW });
    for (const device of DEFAULT_FLEET) {
      const levels = payloads.filter((p) => p.DeviceId === device.imei).map((p) => p.Battery!.Percentage!);
      for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeLessThanOrEqual(levels[i - 1]!);
      expect(levels[0]! - levels[levels.length - 1]!).toBeGreaterThan(0);
    }
  });

  it('moves along the lane toward the destination', () => {
    const { payloads } = generateRealistic({ count: 60, seed: 5, now: NOW });
    const truck = payloads.filter((p) => p.DeviceId === DEFAULT_FLEET[0]!.imei);
    expect(truck[truck.length - 1]!.Location.Latitude).toBeGreaterThan(truck[0]!.Location.Latitude);
  });

  it('uses all three location methods with matching accuracy', () => {
    const { payloads } = generateRealistic({ count: 120, seed: 8, now: NOW });
    const methods = new Set(payloads.map((p) => p.Location.LocationMethod));
    expect(methods).toEqual(new Set(['gps', 'wifi', 'cell']));
    for (const p of payloads) {
      const m = p.Location.Accuracy!.Meters!;
      if (p.Location.LocationMethod === 'gps') expect(m).toBeLessThanOrEqual(15);
      if (p.Location.LocationMethod === 'cell') expect(m).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('scenario plans', () => {
  it('lists every scenario with sane counts', () => {
    const ids = listScenarios().map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'realistic',
        'samples',
        'invalid-coordinates',
        'missing-device-id',
        'epoch-seconds',
        'numeric-strings',
        'sentinel-probe',
        'duplicate-resend',
        'conflicting-resend',
        'future-timestamp',
        'malformed-json',
        'wrong-api-key',
        'oversized-body',
        'batch',
        'edge-suite',
      ]),
    );
    for (const s of listScenarios()) {
      expect(s.defaultCount).toBeGreaterThanOrEqual(1);
      expect(s.defaultCount).toBeLessThanOrEqual(s.maxCount);
    }
  });

  it('builds the same realistic plan for the same seed and now', () => {
    const a = buildPlan('realistic', { count: 5, seed: 77, now: NOW });
    const b = buildPlan('realistic', { count: 5, seed: 77, now: NOW });
    expect(a.steps.map((s) => s.body)).toEqual(b.steps.map((s) => s.body));
    expect(a.steps).toHaveLength(5);
  });

  it('clamps count to the scenario maximum', () => {
    expect(buildPlan('realistic', { count: 5000, seed: 1, now: NOW }).steps).toHaveLength(200);
    expect(buildPlan('samples', { count: 99, seed: 1, now: NOW }).steps).toHaveLength(loadSamples().length);
  });

  it('rejects an unknown scenario', () => {
    expect(() => buildPlan('nope')).toThrow(/Unknown scenario/);
  });

  it('every realistic step body is the JSON of a schema-valid payload', () => {
    for (const step of buildPlan('realistic', { count: 30, seed: 3, now: NOW }).steps) {
      expect(validateTive(JSON.parse(step.body))).toBe(true);
    }
  });

  it('sends every provided sample with an expectation', () => {
    const steps = buildPlan('samples', { seed: 1 }).steps;
    expect(steps).toHaveLength(13);
    for (const s of steps) expect(s.expect.httpStatus.length).toBeGreaterThan(0);
    const rejected = steps.filter((s) => s.expect.apiStatus?.includes('rejected')).map((s) => s.label);
    expect(rejected).toEqual(['Device Name Only', 'Clinical Supply Shipment', 'Entity and Device Name']);
    const clinical = steps.find((s) => s.label === 'Clinical Supply Shipment')!;
    expect(clinical.expect.errorCodes).toEqual(['ACCOUNT_MISMATCH']);
    expect(clinical.expect.alternatives?.[0]?.apiStatus).toEqual(['processed', 'duplicate']);
    expect(clinical.expect.note).toContain('scoped to account 478');
  });

  it('puts every realistic and edge-case payload in the demo account', () => {
    const accounts = new Set<unknown>();
    for (const s of listScenarios()) {
      if (s.id === 'samples') continue;
      for (const step of buildPlan(s.id, { seed: 7, count: Math.min(5, s.maxCount) }).steps) {
        const items = Array.isArray(step.payload) ? step.payload : [step.payload];
        for (const p of items) if (p && typeof p === 'object' && 'AccountId' in p) accounts.add((p as { AccountId: unknown }).AccountId);
      }
    }
    expect([...accounts]).toEqual([DEMO_ACCOUNT_ID]);
  });
});
