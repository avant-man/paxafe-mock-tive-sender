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

export interface Expectation {
  httpStatus: number[];
  apiStatus?: string[];
  errorCodes?: string[];
  warningCodes?: string[];
  batchSize?: number;
  alternatives?: Omit<Expectation, 'note' | 'alternatives'>[];
  note: string;
}

export interface Step {
  label: string;
  body: string;
  payload?: unknown;
  contentType: string;
  auth: 'default' | 'wrong' | 'none';
  imei?: string;
  expect: Expectation;
}

export interface Plan {
  scenario: string;
  seed: number;
  steps: Step[];
}
