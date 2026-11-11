import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Expectation, Step } from '../types.js';

export interface SamplePayload {
  name: string;
  description: string;
  payload: Record<string, unknown>;
}

const SCHEMAS_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url));

export function schemaPath(file: string): string {
  return SCHEMAS_DIR + file;
}

let cache: SamplePayload[] | null = null;

export function loadSamples(): SamplePayload[] {
  if (!cache) {
    const raw = JSON.parse(readFileSync(schemaPath('sample-tive-payloads.json'), 'utf8')) as { payloads: SamplePayload[] };
    cache = raw.payloads;
  }
  return cache;
}

const STORED = ['processed', 'duplicate'];

/**
 * What the Integration API should answer for each provided sample (from DESIGN-SPEC.md).
 * `duplicate` is accepted because the samples have fixed keys, so a second run repeats them.
 */
export const SAMPLE_EXPECTATIONS: Record<string, Omit<Expectation, 'note'>> = {
  'Standard Temperature Shipment': { httpStatus: [200, 201], apiStatus: STORED },
  // Same key as the standard shipment, different content, and latitude 95.
  'Device A571992 Reading': { httpStatus: [200, 201], apiStatus: ['duplicate_conflict', 'partial'] },
  'GPS Location Shipment': { httpStatus: [200, 201], apiStatus: STORED },
  'Vaccine Shipment Checkpoint': { httpStatus: [200, 201], apiStatus: STORED, warningCodes: ['SENSOR_SENTINEL'] },
  'Device Name Only': { httpStatus: [422], apiStatus: ['rejected'], errorCodes: ['DEVICE_ID_INVALID'] },
  'Biologics Replenishment Shipment': {
    httpStatus: [200, 201],
    apiStatus: STORED,
    warningCodes: ['TIMESTAMP_SECONDS_COERCED'],
  },
  'Cellular Location Only': { httpStatus: [200, 201], apiStatus: STORED, warningCodes: ['SENSOR_SENTINEL'] },
  'Standard Temperature Shipment Update': { httpStatus: [200, 201], apiStatus: STORED },
  // Same key as the standard shipment, different content, and longitude -200.
  'Device A571992 Follow-up Reading': { httpStatus: [200, 201], apiStatus: ['duplicate_conflict', 'partial'] },
  'Clinical Supply Shipment': { httpStatus: [200, 201], apiStatus: STORED },
  'Minimal Data Payload': { httpStatus: [200, 201], apiStatus: STORED },
  'Vaccine Shipment Southbound': { httpStatus: [200, 201], apiStatus: STORED },
  'Entity and Device Name': { httpStatus: [422], apiStatus: ['rejected'], errorCodes: ['DEVICE_ID_INVALID'] },
};

export function sampleSteps(count?: number): Step[] {
  const samples = loadSamples();
  const n = Math.min(samples.length, Math.max(1, count ?? samples.length));
  return samples.slice(0, n).map((s) => {
    const expect = SAMPLE_EXPECTATIONS[s.name] ?? { httpStatus: [200, 201, 422] };
    const deviceId = s.payload['DeviceId'];
    return {
      label: s.name,
      body: JSON.stringify(s.payload),
      payload: s.payload,
      contentType: 'application/json',
      auth: 'default',
      imei: typeof deviceId === 'string' ? deviceId : undefined,
      expect: { ...expect, note: s.description },
    } satisfies Step;
  });
}
