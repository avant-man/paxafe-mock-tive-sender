/** Shape of a Tive webhook payload (see schemas/tive-incoming-schema.json). */
export interface TivePayload {
  EntityName?: string;
  EntryTimeEpoch: number;
  EntryTimeUtc?: string;
  Cellular?: { SignalStrength: SignalStrength | null; Dbm: number | null } | null;
  Temperature: { Celsius: number | null; Fahrenheit?: number | null };
  ProbeTemperature?: { Celsius: number | null; Fahrenheit: number | null } | null;
  Humidity?: { Percentage: number | null } | null;
  Accelerometer?: { G: number | null; X: number | null; Y: number | null; Z: number | null } | null;
  Light?: { Lux: number | null } | null;
  Battery?: {
    Percentage: number | null;
    Estimation: 'N/A' | 'Days' | 'Weeks' | 'Months' | null;
    IsCharging: boolean | null;
  } | null;
  Shipment?: {
    Id: string | null;
    Description: string | null;
    DeviceId: string | null;
    ShipFrom: GeoPoint | null;
    ShipTo: GeoPoint | null;
    Carrier: string | null;
  } | null;
  AccountId?: number;
  DeviceId: string;
  DeviceName: string;
  ShipmentId?: string | null;
  PublicShipmentId?: string | null;
  Location: {
    Latitude: number;
    Longitude: number;
    FormattedAddress?: string | null;
    LocationMethod?: LocationMethod | null;
    Accuracy?: { Meters: number | null; Kilometers: number | null; Miles: number | null } | null;
    GeolocationSourceName?: string | null;
    CellTowerUsedCount?: number | null;
    WifiAccessPointUsedCount?: number | null;
  };
}

export type SignalStrength = 'No signal' | 'Poor' | 'Fair' | 'Good';
export type LocationMethod = 'gps' | 'wifi' | 'cell';

export interface GeoPoint {
  Latitude: number | null;
  Longitude: number | null;
  FormattedAddress: string | null;
}

/** What the sender expects the Integration API to answer for one request. */
export interface Expectation {
  /** Accepted HTTP status codes. */
  httpStatus: number[];
  /** Accepted `status` values in the response body (single item responses). */
  apiStatus?: string[];
  /** Error codes that must be present in the response. */
  errorCodes?: string[];
  /** Warning codes that must be present (skipped when the API answers `duplicate`). */
  warningCodes?: string[];
  /** For batch requests: the number of items in `results`. */
  batchSize?: number;
  /**
   * Other answers that also count as expected, for a request whose outcome depends on how
   * the target is set up (for example a key scoped to one account). Any one match is enough.
   */
  alternatives?: Omit<Expectation, 'note' | 'alternatives'>[];
  /** One line that says what this request tests. */
  note: string;
}

/** One HTTP request the sender will make. */
export interface Step {
  label: string;
  /** Raw request body, sent as is. */
  body: string;
  /** Parsed body for display and tests. Undefined when the body is not valid JSON. */
  payload?: unknown;
  contentType: string;
  /** `default` uses the configured key, `wrong` sends a random bad key, `none` sends no key. */
  auth: 'default' | 'wrong' | 'none';
  imei?: string;
  expect: Expectation;
}

export interface Plan {
  scenario: string;
  seed: number;
  steps: Step[];
}
