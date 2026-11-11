import type { Expectation, Step, TivePayload } from '../types.js';
import { cToF, generateRealistic, randomFleet } from './realistic.js';
import { createRng, type Rng } from './rng.js';

/** The Integration API rejects bodies above this size with 413. */
export const BODY_LIMIT_BYTES = 1024 * 1024;
export const MAX_BATCH = 100;
export const SENTINELS = [327.67, -327.68, 32767, -32768, -3276.8, 3276.7] as const;

export interface EdgeCaseContext {
  seed: number;
  /** Epoch ms used as "now". */
  now: number;
  /** Which instance this is (0-based), used to rotate variants. */
  index: number;
  /** Batch size, only used by the batch case. */
  batchSize: number;
}

export interface EdgeCaseInstance {
  /** The valid payload(s) the case starts from, before the single mutation. */
  base: TivePayload[];
  steps: Step[];
}

export interface EdgeCase {
  id: string;
  label: string;
  description: string;
  /** The one rule this case breaks. */
  rule: string;
  /** JSON pointer paths the mutation is allowed to touch. Empty for transport-level cases. */
  paths: string[];
  /** What `count` means for this case. */
  countMeaning: 'instances' | 'batch size';
  defaultCount: number;
  maxCount: number;
  build(ctx: EdgeCaseContext): EdgeCaseInstance;
}

/** One valid reading on a random device, so each instance has its own idempotency key. */
export function basePayload(rng: Rng, now: number): TivePayload {
  const { payloads } = generateRealistic({
    count: 1,
    seed: rng.int(0, 0xffffffff),
    now,
    fleet: randomFleet(rng, 1),
    excursion: false,
  });
  return payloads[0]!;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function jsonStep(label: string, payload: unknown, expect: Expectation, extra: Partial<Step> = {}): Step {
  const imei = !Array.isArray(payload) && payload && typeof payload === 'object' ? (payload as { DeviceId?: unknown }).DeviceId : undefined;
  return {
    label,
    body: JSON.stringify(payload),
    payload,
    contentType: 'application/json',
    auth: 'default',
    imei: typeof imei === 'string' ? imei : undefined,
    expect,
    ...extra,
  };
}

function setUtc(p: TivePayload): void {
  p.EntryTimeUtc = new Date(p.EntryTimeEpoch).toISOString().replace('.000Z', 'Z');
}

function rngFor(ctx: EdgeCaseContext, salt: number): Rng {
  // Mix seed, case and instance so each instance gets its own devices.
  return createRng((ctx.seed ^ Math.imul(salt + 1, 0x9e3779b1) ^ Math.imul(ctx.index + 1, 0x85ebca6b)) >>> 0);
}

const COORD_VARIANTS: ReadonlyArray<{ name: string; lat?: number; lon?: number }> = [
  { name: 'latitude 95', lat: 95 },
  { name: 'longitude -200', lon: -200 },
  { name: 'null island 0,0', lat: 0, lon: 0 },
  { name: 'latitude -91', lat: -91 },
];

const DEVICE_ID_VARIANTS = ['missing', '14 digits', 'letters'] as const;

export const EDGE_CASES: readonly EdgeCase[] = [
  {
    id: 'invalid-coordinates',
    label: 'Invalid coordinates',
    description: 'Latitude or longitude out of range, or 0,0. The sensor reading must survive, the location is skipped.',
    rule: 'Location validity: lat in [-90, 90], lon in [-180, 180], not both 0',
    paths: ['/Location/Latitude', '/Location/Longitude'],
    countMeaning: 'instances',
    defaultCount: 4,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 1), ctx.now - ctx.index * 60_000);
      const variant = COORD_VARIANTS[ctx.index % COORD_VARIANTS.length]!;
      const p = clone(base);
      if (variant.lat !== undefined) p.Location.Latitude = variant.lat;
      if (variant.lon !== undefined) p.Location.Longitude = variant.lon;
      return {
        base: [base],
        steps: [
          jsonStep(`Invalid coordinates (${variant.name})`, p, {
            httpStatus: [201],
            apiStatus: ['partial'],
            warningCodes: ['LOCATION_INVALID'],
            note: 'Sensor stored, location skipped with LOCATION_INVALID',
          }),
        ],
      };
    },
  },
  {
    id: 'missing-device-id',
    label: 'Missing or bad DeviceId',
    description: 'DeviceId missing, 14 digits, or with letters. No IMEI guessing from DeviceName.',
    rule: 'DeviceId present and matches ^[0-9]{15}$',
    paths: ['/DeviceId'],
    countMeaning: 'instances',
    defaultCount: 3,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 2), ctx.now - ctx.index * 60_000);
      const variant = DEVICE_ID_VARIANTS[ctx.index % DEVICE_ID_VARIANTS.length]!;
      const p = clone(base) as Partial<TivePayload>;
      if (variant === 'missing') delete p.DeviceId;
      else if (variant === '14 digits') p.DeviceId = base.DeviceId.slice(0, 14);
      else p.DeviceId = `${base.DeviceId.slice(0, 12)}ABC`;
      return {
        base: [base],
        steps: [
          jsonStep(`DeviceId ${variant}`, p, {
            httpStatus: [422],
            apiStatus: ['rejected'],
            errorCodes: ['DEVICE_ID_INVALID'],
            note: 'Rejected, the IMEI is the identity',
          }),
        ],
      };
    },
  },
  {
    id: 'epoch-seconds',
    label: 'Epoch in seconds',
    description: 'EntryTimeEpoch sent in seconds instead of milliseconds.',
    rule: 'EntryTimeEpoch is in milliseconds (values below 1e11 are seconds)',
    paths: ['/EntryTimeEpoch'],
    countMeaning: 'instances',
    defaultCount: 1,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 3), ctx.now - ctx.index * 60_000);
      const p = clone(base);
      p.EntryTimeEpoch = Math.floor(base.EntryTimeEpoch / 1000);
      return {
        base: [base],
        steps: [
          jsonStep('Epoch in seconds', p, {
            httpStatus: [201],
            apiStatus: ['processed'],
            warningCodes: ['TIMESTAMP_SECONDS_COERCED'],
            note: 'Stored, epoch multiplied by 1000 with a warning',
          }),
        ],
      };
    },
  },
  {
    id: 'numeric-strings',
    label: 'Numeric strings',
    description: 'Temperature, humidity and Dbm sent as strings, like "10.5" and "-100".',
    rule: 'Numeric fields are JSON numbers',
    paths: ['/Temperature/Celsius', '/Temperature/Fahrenheit', '/Humidity/Percentage', '/Cellular/Dbm'],
    countMeaning: 'instances',
    defaultCount: 1,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 4), ctx.now - ctx.index * 60_000);
      const p = clone(base) as unknown as Record<string, Record<string, unknown>>;
      p['Temperature']!['Celsius'] = String(base.Temperature.Celsius);
      p['Temperature']!['Fahrenheit'] = String(base.Temperature.Fahrenheit);
      p['Humidity']!['Percentage'] = String(base.Humidity!.Percentage);
      p['Cellular']!['Dbm'] = String(base.Cellular!.Dbm);
      return {
        base: [base],
        steps: [
          jsonStep('Numeric strings', p, {
            httpStatus: [201],
            apiStatus: ['processed'],
            note: 'Stored, strings coerced to numbers',
          }),
        ],
      };
    },
  },
  {
    id: 'sentinel-probe',
    label: 'Sentinel probe',
    description: 'ProbeTemperature carries a sensor sentinel such as 327.67 or -32768.',
    rule: 'Temperatures are real readings, not sensor sentinels',
    paths: ['/ProbeTemperature/Celsius', '/ProbeTemperature/Fahrenheit'],
    countMeaning: 'instances',
    defaultCount: 2,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 5), ctx.now - ctx.index * 60_000);
      const sentinel = SENTINELS[ctx.index % SENTINELS.length]!;
      const p = clone(base);
      p.ProbeTemperature = { Celsius: sentinel, Fahrenheit: cToF(sentinel) };
      return {
        base: [base],
        steps: [
          jsonStep(`Sentinel probe ${sentinel}`, p, {
            httpStatus: [201],
            apiStatus: ['processed'],
            warningCodes: ['SENSOR_SENTINEL'],
            note: 'Stored, probe nulled with SENSOR_SENTINEL',
          }),
        ],
      };
    },
  },
  {
    id: 'duplicate-resend',
    label: 'Duplicate resend',
    description: 'The same payload sent twice, like a Tive retry.',
    rule: 'Idempotency: (DeviceId, EntryTimeEpoch) is stored once',
    paths: [],
    countMeaning: 'instances',
    defaultCount: 1,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 6), ctx.now - ctx.index * 60_000);
      return {
        base: [base],
        steps: [
          jsonStep('Duplicate resend: first send', base, {
            httpStatus: [201],
            apiStatus: ['processed'],
            note: 'First send is stored',
          }),
          jsonStep('Duplicate resend: second send', clone(base), {
            httpStatus: [200],
            apiStatus: ['duplicate'],
            note: 'Identical resend is a duplicate, nothing new stored',
          }),
        ],
      };
    },
  },
  {
    id: 'conflicting-resend',
    label: 'Conflicting resend',
    description: 'Same device and timestamp, different temperature.',
    rule: 'Idempotency: first write wins, a different body for the same key is a conflict',
    paths: ['/Temperature/Celsius', '/Temperature/Fahrenheit'],
    countMeaning: 'instances',
    defaultCount: 1,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 7), ctx.now - ctx.index * 60_000);
      const p = clone(base);
      const c = (base.Temperature.Celsius ?? 5) + 1.5;
      p.Temperature = { Celsius: c, Fahrenheit: cToF(c) };
      return {
        base: [base],
        steps: [
          jsonStep('Conflicting resend: original', base, {
            httpStatus: [201],
            apiStatus: ['processed'],
            note: 'Original is stored',
          }),
          jsonStep('Conflicting resend: changed temperature', p, {
            httpStatus: [200],
            apiStatus: ['duplicate_conflict'],
            note: 'Changed body for the same key is kept for review, not overwritten',
          }),
        ],
      };
    },
  },
  {
    id: 'future-timestamp',
    label: 'Future timestamp',
    description: 'EntryTimeEpoch 48 hours in the future.',
    rule: 'EntryTimeEpoch is not more than 24 h in the future',
    paths: ['/EntryTimeEpoch', '/EntryTimeUtc'],
    countMeaning: 'instances',
    defaultCount: 1,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 8), ctx.now - ctx.index * 60_000);
      const p = clone(base);
      p.EntryTimeEpoch = base.EntryTimeEpoch + 48 * 3_600_000;
      setUtc(p);
      return {
        base: [base],
        steps: [
          jsonStep('Future timestamp (+48 h)', p, {
            httpStatus: [422],
            apiStatus: ['rejected'],
            errorCodes: ['TIMESTAMP_FUTURE'],
            note: 'Rejected, a device clock 2 days ahead is not trusted',
          }),
        ],
      };
    },
  },
  {
    id: 'malformed-json',
    label: 'Malformed JSON',
    description: 'A valid payload cut off before the end.',
    rule: 'The body is valid JSON',
    paths: [],
    countMeaning: 'instances',
    defaultCount: 1,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 9), ctx.now - ctx.index * 60_000);
      const text = JSON.stringify(base);
      return {
        base: [base],
        steps: [
          {
            label: 'Malformed JSON (truncated)',
            body: text.slice(0, text.length - 17),
            contentType: 'application/json',
            auth: 'default',
            imei: base.DeviceId,
            expect: { httpStatus: [400], note: 'Rejected with 400, raw text still logged' },
          },
        ],
      };
    },
  },
  {
    id: 'wrong-api-key',
    label: 'Wrong or missing API key',
    description: 'A valid payload with a bad key, or with no key (alternating).',
    rule: 'Requests carry a valid API key',
    paths: [],
    countMeaning: 'instances',
    defaultCount: 2,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 10), ctx.now - ctx.index * 60_000);
      const auth = ctx.index % 2 === 0 ? 'wrong' : 'none';
      return {
        base: [base],
        steps: [
          jsonStep(auth === 'wrong' ? 'Wrong API key' : 'No API key', base, { httpStatus: [401], note: 'Unauthorized' }, { auth }),
        ],
      };
    },
  },
  {
    id: 'wrong-content-type',
    label: 'Wrong content type',
    description: 'A valid payload sent as text/plain.',
    rule: 'Content-Type is application/json',
    paths: [],
    countMeaning: 'instances',
    defaultCount: 1,
    maxCount: 20,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 11), ctx.now - ctx.index * 60_000);
      return {
        base: [base],
        steps: [
          jsonStep('Content-Type text/plain', base, { httpStatus: [415], note: 'Unsupported media type' }, { contentType: 'text/plain' }),
        ],
      };
    },
  },
  {
    id: 'oversized-body',
    label: 'Oversized body',
    description: 'A valid payload padded above the 1 MB body limit.',
    rule: 'The body is at most 1 MB',
    paths: ['/EntityName'],
    countMeaning: 'instances',
    defaultCount: 1,
    maxCount: 3,
    build(ctx) {
      const base = basePayload(rngFor(ctx, 12), ctx.now - ctx.index * 60_000);
      const p = clone(base);
      p.EntityName = `${base.EntityName ?? ''}-${'x'.repeat(BODY_LIMIT_BYTES + 64 * 1024)}`;
      return {
        base: [base],
        steps: [jsonStep('Oversized body (~1.06 MB)', p, { httpStatus: [413], note: 'Payload too large' })],
      };
    },
  },
  {
    id: 'batch',
    label: 'Batch of K',
    description: 'K valid readings in one array body. Above 100 items the API must answer 400.',
    rule: 'A batch holds 1 to 100 items',
    paths: [],
    countMeaning: 'batch size',
    defaultCount: 10,
    maxCount: 150,
    build(ctx) {
      const rng = rngFor(ctx, 13);
      const k = Math.max(1, ctx.batchSize);
      const { payloads } = generateRealistic({
        count: k,
        seed: rng.int(0, 0xffffffff),
        now: ctx.now,
        fleet: randomFleet(rng, 3),
        excursion: false,
      });
      const expect: Expectation =
        k <= MAX_BATCH
          ? { httpStatus: [207], batchSize: k, note: `Multi-status with ${k} results in order` }
          : { httpStatus: [400], note: `More than ${MAX_BATCH} items is rejected` };
      return { base: payloads, steps: [jsonStep(`Batch of ${k}`, payloads, expect)] };
    },
  },
];

export function edgeCaseById(id: string): EdgeCase | undefined {
  return EDGE_CASES.find((c) => c.id === id);
}
