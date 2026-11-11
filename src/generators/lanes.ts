/**
 * Real US cold-chain lanes. Waypoints are city centers along the usual truck route.
 * Addresses use the "City, ST 12345, USA" shape that the Integration API address
 * parser understands; the ends use street addresses.
 */
export interface Waypoint {
  lat: number;
  lon: number;
  address: string;
}

export interface Lane {
  id: string;
  name: string;
  carrier: string;
  description: string;
  waypoints: Waypoint[];
}

export const LANES: readonly Lane[] = [
  {
    id: 'pharr-bronx',
    name: 'Pharr, TX to Bronx, NY',
    carrier: 'EXCALIBUR',
    description: 'Produce and pharma reefer lane, Rio Grande Valley to Hunts Point',
    waypoints: [
      { lat: 26.09891, lon: -98.18494, address: '1460 E Hi Line Rd, Pharr, TX 78577, USA' },
      { lat: 29.4241, lon: -98.4936, address: 'San Antonio, TX 78205, USA' },
      { lat: 32.7767, lon: -96.797, address: 'Dallas, TX 75201, USA' },
      { lat: 33.4251, lon: -94.0477, address: 'Texarkana, TX 75501, USA' },
      { lat: 34.7465, lon: -92.2896, address: 'Little Rock, AR 72201, USA' },
      { lat: 35.1495, lon: -90.049, address: 'Memphis, TN 38103, USA' },
      { lat: 36.1627, lon: -86.7816, address: 'Nashville, TN 37203, USA' },
      { lat: 35.9606, lon: -83.9207, address: 'Knoxville, TN 37902, USA' },
      { lat: 37.271, lon: -79.9414, address: 'Roanoke, VA 24011, USA' },
      { lat: 40.2732, lon: -76.8867, address: 'Harrisburg, PA 17101, USA' },
      { lat: 40.7357, lon: -74.1724, address: 'Newark, NJ 07102, USA' },
      { lat: 40.815468, lon: -73.8805, address: '772 Edgewater Rd, Bronx, NY 10474, USA' },
    ],
  },
  {
    id: 'memphis-chicago',
    name: 'Memphis, TN to Chicago, IL',
    carrier: 'COLDLINE-FREIGHT',
    description: 'Air hub to Midwest distribution center',
    waypoints: [
      { lat: 35.0456, lon: -89.9773, address: '2903 Sprankel Ave, Memphis, TN 38118, USA' },
      { lat: 35.6145, lon: -88.8139, address: 'Jackson, TN 38301, USA' },
      { lat: 37.0834, lon: -88.6, address: 'Paducah, KY 42001, USA' },
      { lat: 38.3173, lon: -88.9031, address: 'Mount Vernon, IL 62864, USA' },
      { lat: 39.12, lon: -88.5434, address: 'Effingham, IL 62401, USA' },
      { lat: 40.1164, lon: -88.2434, address: 'Champaign, IL 61820, USA' },
      { lat: 41.12, lon: -87.8612, address: 'Kankakee, IL 60901, USA' },
      { lat: 41.8781, lon: -87.6298, address: '1200 W Harrison St, Chicago, IL 60607, USA' },
    ],
  },
  {
    id: 'durham-boston',
    name: 'Durham, NC to Boston, MA',
    carrier: 'FEDEX-COLD',
    description: 'Research Triangle biologics to New England hospitals',
    waypoints: [
      { lat: 35.994, lon: -78.8986, address: '5 Moore Dr, Durham, NC 27709, USA' },
      { lat: 37.5407, lon: -77.436, address: 'Richmond, VA 23219, USA' },
      { lat: 38.9072, lon: -77.0369, address: 'Washington, DC 20001, USA' },
      { lat: 39.2904, lon: -76.6122, address: 'Baltimore, MD 21201, USA' },
      { lat: 39.9526, lon: -75.1652, address: 'Philadelphia, PA 19103, USA' },
      { lat: 40.7506, lon: -73.9972, address: 'New York, NY 10001, USA' },
      { lat: 41.7658, lon: -72.6734, address: 'Hartford, CT 06103, USA' },
      { lat: 42.3601, lon: -71.0589, address: '75 Francis St, Boston, MA 02115, USA' },
    ],
  },
];

export function laneById(id: string): Lane {
  const lane = LANES.find((l) => l.id === id);
  if (!lane) throw new Error(`Unknown lane: ${id}`);
  return lane;
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function laneLengthKm(lane: Lane): number {
  let total = 0;
  for (let i = 1; i < lane.waypoints.length; i++) {
    total += haversineKm(lane.waypoints[i - 1]!, lane.waypoints[i]!);
  }
  return total;
}

/**
 * Position at `progress` (0..1) along the lane, by straight-line interpolation
 * between waypoints. `address` is the nearest waypoint's address.
 */
export function positionAt(lane: Lane, progress: number): { lat: number; lon: number; address: string } {
  const p = Math.min(1, Math.max(0, progress));
  const target = p * laneLengthKm(lane);
  let walked = 0;
  const wps = lane.waypoints;
  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1]!;
    const b = wps[i]!;
    const seg = haversineKm(a, b);
    if (walked + seg >= target || i === wps.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, (target - walked) / seg);
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        address: t < 0.5 ? a.address : b.address,
      };
    }
    walked += seg;
  }
  const last = wps[wps.length - 1]!;
  return { lat: last.lat, lon: last.lon, address: last.address };
}
