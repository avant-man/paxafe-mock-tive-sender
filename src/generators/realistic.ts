import type { LocationMethod, SignalStrength, TivePayload } from '../types.js';
import { laneById, laneLengthKm, positionAt, type Lane } from './lanes.js';
import { createRng, type Rng } from './rng.js';

export interface FleetDevice {
  imei: string;
  name: string;
  laneId: string;
  accountId: number;
  shipmentId: string;
  publicShipmentId: string;
}

/**
 * The demo account. Every realistic and edge-case payload uses it, so a deployed sender
 * can use an API key scoped to this one account.
 */
export const DEMO_ACCOUNT_ID = 478;

/** The default fleet: fixed IMEIs, so readings from many runs pile up on the same devices. */
export const DEFAULT_FLEET: readonly FleetDevice[] = [
  {
    imei: '864475040010017',
    name: 'T100201',
    laneId: 'pharr-bronx',
    accountId: DEMO_ACCOUNT_ID,
    shipmentId: 'CL-20417/PHARMA-SHIP/COLD-LOGISTICS',
    publicShipmentId: 'K7Q2M9TX4B',
  },
  {
    imei: '864475040010025',
    name: 'T100202',
    laneId: 'memphis-chicago',
    accountId: DEMO_ACCOUNT_ID,
    shipmentId: 'PO-55120/INSULIN-LANE',
    publicShipmentId: 'R3HW8N2PLC',
  },
  {
    imei: '864475040010033',
    name: 'T100203',
    laneId: 'durham-boston',
    accountId: DEMO_ACCOUNT_ID,
    shipmentId: 'INV-78034/BIOLOGICS',
    publicShipmentId: 'Z5TB1VQ8MK',
  },
];

/** A fleet with random IMEIs, so edge-case runs never collide with earlier runs. */
export function randomFleet(rng: Rng, size = 1): FleetDevice[] {
  return Array.from({ length: size }, (_, i) => {
    const base = DEFAULT_FLEET[i % DEFAULT_FLEET.length]!;
    return {
      ...base,
      imei: `86${rng.digits(13)}`,
      name: `X${rng.digits(6)}`,
      publicShipmentId: rng.alnum(10),
    };
  });
}

export interface RealisticOptions {
  count: number;
  seed: number;
  /** Epoch ms of the newest reading. Defaults to Date.now(). */
  now?: number;
  fleet?: readonly FleetDevice[];
  /** true forces one excursion, false disables it, undefined lets the seed decide (50%). */
  excursion?: boolean;
  intervalMinutes?: number;
}

export interface Excursion {
  imei: string;
  /** Indexes into `payloads` of the readings that are part of the excursion. */
  indexes: number[];
  peakCelsius: number;
}

export interface RealisticResult {
  payloads: TivePayload[];
  excursion: Excursion | null;
}

const TRUCK_KM_PER_HOUR = 80;
const SETPOINT_C = 5;
const EXCURSION_RISE_C = [2.5, 5.5, 6.5, 4];

/**
 * N readings from a small fleet, round robin across devices, 15 minutes apart per
 * device. Temperatures are 2-8 C with noise, optionally one excursion above 8 C.
 * Pure: the same options always give the same payloads.
 */
export function generateRealistic(opts: RealisticOptions): RealisticResult {
  const { count, seed } = opts;
  const fleet = opts.fleet ?? DEFAULT_FLEET;
  if (fleet.length === 0) throw new Error('fleet must not be empty');
  const now = Math.floor((opts.now ?? Date.now()) / 1000) * 1000;
  const intervalMs = (opts.intervalMinutes ?? 15) * 60_000;
  const rng = createRng(seed);

  const perDevice = fleet.map((_, d) => Math.ceil((count - d) / fleet.length));
  const state = fleet.map((device) => {
    const lane = laneById(device.laneId);
    return {
      device,
      lane,
      laneKm: laneLengthKm(lane),
      startProgress: rng.float(0.05, 0.6),
      battery: rng.int(70, 100),
      humidity: rng.float(38, 55),
      orientation: unitVector(rng),
      offsetSec: rng.int(0, 120),
    };
  });

  const wantExcursion = opts.excursion ?? rng.chance(0.5);
  const excursionDevice = rng.int(0, fleet.length - 1);
  const excursionDeviceSteps = perDevice[excursionDevice] ?? 0;
  const excursionStart =
    wantExcursion && excursionDeviceSteps > 0
      ? rng.int(0, Math.max(0, excursionDeviceSteps - EXCURSION_RISE_C.length))
      : -1;

  const payloads: TivePayload[] = [];
  const excursionIndexes: number[] = [];
  let peak = -Infinity;

  for (let k = 0; k < count; k++) {
    const d = k % fleet.length;
    const step = Math.floor(k / fleet.length);
    const s = state[d]!;
    const steps = perDevice[d]!;
    const ts = now - (steps - 1 - step) * intervalMs - s.offsetSec * 1000;

    let celsius = rng.normal(SETPOINT_C, 0.35);
    const excursionStep = d === excursionDevice && excursionStart >= 0 ? step - excursionStart : -1;
    const inExcursion = excursionStep >= 0 && excursionStep < EXCURSION_RISE_C.length;
    if (inExcursion) celsius += EXCURSION_RISE_C[excursionStep]!;
    celsius = clamp(celsius, 2, 15);
    const tempC = quantize(celsius, 64);
    if (inExcursion) {
      excursionIndexes.push(k);
      peak = Math.max(peak, tempC);
    }
    const probeC = quantize(celsius - 0.15 + rng.normal(0, 0.1), 16);

    const kmPerStep = (TRUCK_KM_PER_HOUR * intervalMs) / 3_600_000;
    const progress = s.startProgress + (step * kmPerStep) / s.laneKm;
    const pos = positionAt(s.lane, progress);
    const method = rng.pick<LocationMethod>(['gps', 'gps', 'wifi', 'cell']);
    const fix = locationFix(rng, method);

    s.battery = Math.max(1, s.battery - (rng.chance(0.35) ? 1 : 0));
    s.humidity = clamp(s.humidity + rng.normal(0, 0.6), 30, 65);
    const dbm = Math.round(clamp(rng.normal(-88, 9), -120, -55));

    const shake = () => rng.normal(0, 0.02);
    const x = round(s.orientation.x + shake(), 4);
    const y = round(s.orientation.y + shake(), 4);
    const z = round(s.orientation.z + shake(), 4);

    payloads.push({
      EntityName: s.device.name,
      EntryTimeEpoch: ts,
      EntryTimeUtc: new Date(ts).toISOString().replace('.000Z', 'Z'),
      Cellular: { SignalStrength: signalStrength(dbm), Dbm: dbm },
      Temperature: { Celsius: tempC, Fahrenheit: cToF(tempC) },
      ProbeTemperature: { Celsius: probeC, Fahrenheit: cToF(probeC) },
      Humidity: { Percentage: Math.fround(round(s.humidity, 1)) },
      Accelerometer: { G: round(Math.sqrt(x * x + y * y + z * z), 6), X: x, Y: y, Z: z },
      Light: { Lux: rng.chance(0.05) ? round(rng.float(5, 400), 1) : 0 },
      Battery: {
        Percentage: s.battery,
        Estimation: s.battery > 50 ? 'Weeks' : s.battery > 15 ? 'Days' : 'N/A',
        IsCharging: false,
      },
      Shipment: shipment(s.device, s.lane),
      AccountId: s.device.accountId,
      DeviceId: s.device.imei,
      DeviceName: s.device.name,
      ShipmentId: s.device.shipmentId,
      PublicShipmentId: s.device.publicShipmentId,
      Location: {
        Latitude: round(pos.lat + rng.normal(0, fix.jitterDeg), 6),
        Longitude: round(pos.lon + rng.normal(0, fix.jitterDeg), 6),
        FormattedAddress: pos.address,
        LocationMethod: method,
        Accuracy: {
          Meters: fix.meters,
          Kilometers: round(fix.meters / 1000, 3),
          Miles: round(fix.meters / 1609.344, 3),
        },
        GeolocationSourceName: fix.source,
        CellTowerUsedCount: fix.towers,
        WifiAccessPointUsedCount: fix.wifi,
      },
    });
  }

  const device = fleet[excursionDevice]!;
  return {
    payloads,
    excursion: excursionIndexes.length > 0 ? { imei: device.imei, indexes: excursionIndexes, peakCelsius: peak } : null,
  };
}

function shipment(device: FleetDevice, lane: Lane): NonNullable<TivePayload['Shipment']> {
  const from = lane.waypoints[0]!;
  const to = lane.waypoints[lane.waypoints.length - 1]!;
  return {
    Id: device.shipmentId,
    Description: lane.description,
    DeviceId: device.imei,
    ShipFrom: { Latitude: from.lat, Longitude: from.lon, FormattedAddress: from.address },
    ShipTo: { Latitude: to.lat, Longitude: to.lon, FormattedAddress: to.address },
    Carrier: lane.carrier,
  };
}

function locationFix(rng: Rng, method: LocationMethod) {
  switch (method) {
    case 'gps':
      return { meters: rng.int(3, 15), source: 'gnss', towers: 0, wifi: 0, jitterDeg: 0.0001 };
    case 'wifi':
      return { meters: rng.int(18, 90), source: 'skyhook', towers: 1, wifi: rng.int(3, 9), jitterDeg: 0.0005 };
    case 'cell':
      return { meters: rng.int(400, 3500), source: 'cell-triangulation', towers: rng.int(2, 5), wifi: 0, jitterDeg: 0.01 };
  }
}

function signalStrength(dbm: number): SignalStrength {
  if (dbm >= -75) return 'Good';
  if (dbm >= -95) return 'Fair';
  if (dbm >= -110) return 'Poor';
  return 'No signal';
}

function unitVector(rng: Rng) {
  // A box sits mostly upright: z dominates, with a random tilt.
  const x = rng.normal(0, 0.3);
  const y = rng.normal(0, 0.3);
  const z = 1;
  const n = Math.sqrt(x * x + y * y + z * z);
  return { x: x / n, y: y / n, z: z / n };
}

export function cToF(c: number): number {
  return round((c * 9) / 5 + 32, 6);
}

function quantize(value: number, steps: number): number {
  return Math.round(value * steps) / steps;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
