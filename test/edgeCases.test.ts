import { describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES, EDGE_CASES, SENTINELS, edgeCaseById, type EdgeCaseContext } from '../src/generators/edgeCases.js';
import { buildPlan } from '../src/generators/index.js';
import type { TivePayload } from '../src/types.js';
import { diffPaths, schemaErrorPaths, validateTive } from './support/tiveSchema.js';

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const ctx = (index = 0, batchSize = 5): EdgeCaseContext => ({ seed: 2024, now: NOW, index, batchSize });

function build(id: string, index = 0, batchSize = 5) {
  const edge = edgeCaseById(id);
  if (!edge) throw new Error(`no edge case ${id}`);
  return { edge, ...edge.build(ctx(index, batchSize)) };
}

function expectOnlyIntendedChanges(id: string, index = 0) {
  const { edge, base, steps } = build(id, index);
  const mutated = steps[steps.length - 1]!.payload;
  const changed = diffPaths(base[0], mutated);
  expect(changed.length, `${id} should change something`).toBeGreaterThan(0);
  for (const p of changed) expect(edge.paths, `${id} changed ${p}`).toContain(p);
  return { base: base[0]!, mutated: mutated as TivePayload, changed };
}

describe('edge case catalogue', () => {
  it('every case starts from schema-valid base payloads', () => {
    for (const edge of EDGE_CASES) {
      for (let index = 0; index < 4; index++) {
        for (const b of edge.build(ctx(index)).base) {
          expect(schemaErrorPaths(b), `${edge.id}#${index}`).toEqual([]);
        }
      }
    }
  });

  it('gives each instance its own idempotency key', () => {
    for (const edge of EDGE_CASES) {
      const keys = new Set(
        [0, 1, 2, 3].flatMap((index) => edge.build(ctx(index)).base.map((b) => `${b.DeviceId}:${b.EntryTimeEpoch}`)),
      );
      expect(keys.size, edge.id).toBe(edge.id === 'batch' ? 20 : 4);
    }
  });

  it('is stable for a fixed seed', () => {
    const a = buildPlan('edge-suite', { seed: 5, now: NOW }).steps.map((s) => s.body);
    const b = buildPlan('edge-suite', { seed: 5, now: NOW }).steps.map((s) => s.body);
    expect(a).toEqual(b);
  });

  it('edge-suite covers every case once', () => {
    const steps = buildPlan('edge-suite', { seed: 5, now: NOW }).steps;
    expect(steps).toHaveLength(EDGE_CASES.length + 2);
  });
});

describe('each edge case breaks exactly its intended rule', () => {
  it('invalid-coordinates: only Location lat/lon change, every variant is invalid', () => {
    const variants = [0, 1, 2, 3].map((i) => expectOnlyIntendedChanges('invalid-coordinates', i).mutated.Location);
    for (const loc of variants) {
      const bad = loc.Latitude < -90 || loc.Latitude > 90 || loc.Longitude < -180 || loc.Longitude > 180 || (loc.Latitude === 0 && loc.Longitude === 0);
      expect(bad).toBe(true);
    }
    expect(schemaErrorPaths(build('invalid-coordinates', 0).steps[0]!.payload)).toEqual(['/Location/Latitude']);
    expect(schemaErrorPaths(build('invalid-coordinates', 1).steps[0]!.payload)).toEqual(['/Location/Longitude']);
    expect(schemaErrorPaths(build('invalid-coordinates', 2).steps[0]!.payload)).toEqual([]);
  });

  it('missing-device-id: only DeviceId fails, in all three variants', () => {
    for (const i of [0, 1, 2]) {
      const { mutated } = expectOnlyIntendedChanges('missing-device-id', i);
      expect(schemaErrorPaths(mutated)).toEqual(['/DeviceId']);
      expect(mutated.DeviceName).toBeTruthy();
    }
    expect('DeviceId' in (build('missing-device-id', 0).steps[0]!.payload as object)).toBe(false);
  });

  it('epoch-seconds: epoch is in seconds and still matches EntryTimeUtc', () => {
    const { base, mutated } = expectOnlyIntendedChanges('epoch-seconds');
    expect(validateTive(mutated)).toBe(true);
    expect(mutated.EntryTimeEpoch).toBeLessThan(1e11);
    expect(mutated.EntryTimeEpoch * 1000).toBe(base.EntryTimeEpoch);
    expect(Date.parse(mutated.EntryTimeUtc!)).toBe(mutated.EntryTimeEpoch * 1000);
  });

  it('numeric-strings: the four numeric fields are strings of the same numbers', () => {
    const { base, mutated, changed } = expectOnlyIntendedChanges('numeric-strings');
    expect(changed.sort()).toEqual(['/Cellular/Dbm', '/Humidity/Percentage', '/Temperature/Celsius', '/Temperature/Fahrenheit']);
    expect(schemaErrorPaths(mutated).sort()).toEqual(changed.sort());
    expect(Number(mutated.Temperature.Celsius)).toBe(base.Temperature.Celsius);
    expect(Number(mutated.Cellular!.Dbm)).toBe(base.Cellular!.Dbm);
  });

  it('sentinel-probe: probe carries a sentinel, primary temperature untouched', () => {
    for (const i of [0, 1, 2, 3, 4, 5]) {
      const { base, mutated } = expectOnlyIntendedChanges('sentinel-probe', i);
      expect(validateTive(mutated)).toBe(true);
      expect(SENTINELS).toContain(mutated.ProbeTemperature!.Celsius);
      expect(mutated.Temperature).toEqual(base.Temperature);
    }
  });

  it('duplicate-resend: two identical valid bodies', () => {
    const { steps } = build('duplicate-resend');
    expect(steps).toHaveLength(2);
    expect(steps[0]!.body).toBe(steps[1]!.body);
    expect(validateTive(steps[0]!.payload)).toBe(true);
    expect(steps.map((s) => s.expect.apiStatus)).toEqual([['processed'], ['duplicate']]);
  });

  it('conflicting-resend: same key, only the temperature differs, both valid', () => {
    const { steps } = build('conflicting-resend');
    const [a, b] = steps.map((s) => s.payload as TivePayload);
    expect(b!.DeviceId).toBe(a!.DeviceId);
    expect(b!.EntryTimeEpoch).toBe(a!.EntryTimeEpoch);
    expect(diffPaths(a, b).sort()).toEqual(['/Temperature/Celsius', '/Temperature/Fahrenheit']);
    expect(validateTive(a)).toBe(true);
    expect(validateTive(b)).toBe(true);
    expectOnlyIntendedChanges('conflicting-resend');
  });

  it('future-timestamp: more than 24 h ahead, schema-valid, Utc kept consistent', () => {
    const { mutated } = expectOnlyIntendedChanges('future-timestamp');
    expect(validateTive(mutated)).toBe(true);
    expect(mutated.EntryTimeEpoch - NOW).toBeGreaterThan(24 * 3_600_000);
    expect(Date.parse(mutated.EntryTimeUtc!)).toBe(mutated.EntryTimeEpoch);
  });

  it('malformed-json: body does not parse, but is a cut-off valid payload', () => {
    const { base, steps } = build('malformed-json');
    const body = steps[0]!.body;
    expect(() => JSON.parse(body)).toThrow();
    expect(JSON.stringify(base[0]).startsWith(body)).toBe(true);
    expect(steps[0]!.expect.httpStatus).toEqual([400]);
  });

  it('wrong-api-key: valid payload, only the key is wrong or missing', () => {
    const a = build('wrong-api-key', 0).steps[0]!;
    const b = build('wrong-api-key', 1).steps[0]!;
    expect([a.auth, b.auth]).toEqual(['wrong', 'none']);
    expect(validateTive(a.payload)).toBe(true);
    expect(a.contentType).toBe('application/json');
    expect(a.expect.httpStatus).toEqual([401]);
  });

  it('wrong-content-type: valid JSON body sent as text/plain', () => {
    const s = build('wrong-content-type').steps[0]!;
    expect(validateTive(JSON.parse(s.body))).toBe(true);
    expect(s.contentType).toBe('text/plain');
  });

  it('oversized-body: schema-valid payload just above 1 MB', () => {
    const { mutated } = expectOnlyIntendedChanges('oversized-body');
    const s = build('oversized-body').steps[0]!;
    expect(validateTive(mutated)).toBe(true);
    const bytes = Buffer.byteLength(s.body);
    expect(bytes).toBeGreaterThan(BODY_LIMIT_BYTES);
    expect(bytes).toBeLessThan(BODY_LIMIT_BYTES * 1.2);
  });

  it('batch: K valid items with unique keys, 400 expected above 100', () => {
    const small = build('batch', 0, 7).steps[0]!;
    const items = small.payload as TivePayload[];
    expect(items).toHaveLength(7);
    for (const p of items) expect(validateTive(p)).toBe(true);
    expect(new Set(items.map((p) => `${p.DeviceId}:${p.EntryTimeEpoch}`)).size).toBe(7);
    expect(small.expect).toMatchObject({ httpStatus: [207], batchSize: 7 });

    expect(build('batch', 0, 100).steps[0]!.expect.httpStatus).toEqual([207]);
    expect(build('batch', 0, 101).steps[0]!.expect.httpStatus).toEqual([400]);
  });

  it('every edge case id has a dedicated test above', () => {
    expect(EDGE_CASES.map((c) => c.id).sort()).toEqual(
      [
        'batch',
        'conflicting-resend',
        'duplicate-resend',
        'epoch-seconds',
        'future-timestamp',
        'invalid-coordinates',
        'malformed-json',
        'missing-device-id',
        'numeric-strings',
        'oversized-body',
        'sentinel-probe',
        'wrong-api-key',
        'wrong-content-type',
      ].sort(),
    );
  });
});
