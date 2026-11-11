import { readFileSync } from 'node:fs';
import { Ajv, type ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { schemaPath } from '../../src/generators/samples.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

const schema = JSON.parse(readFileSync(schemaPath('tive-incoming-schema.json'), 'utf8')) as object;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
export const validateTive = ajv.compile(schema);

export function schemaErrorPaths(payload: unknown): string[] {
  validateTive(payload);
  const errors: ErrorObject[] = validateTive.errors ?? [];
  return [
    ...new Set(
      errors.map((e) =>
        e.keyword === 'required' ? `${e.instancePath}/${(e.params as { missingProperty: string }).missingProperty}` : e.instancePath,
      ),
    ),
  ];
}

export function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (Object.is(a, b)) return [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diffPaths(a[k], b[k], `${path}/${k}`));
}
