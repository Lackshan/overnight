// Mirrors the Go API's JSON.

export type PlanId = "anonymous" | "free" | "pro";

export interface FeatureState {
  label: string;
  allowed: boolean;
  unlocks_on?: PlanId;
}

export interface Session {
  plan: PlanId;
  email?: string;
  features: Record<string, FeatureState>;
  limits: Record<string, number>;
  plans: Record<PlanId, { name: string; price_label?: string }>;
  dev_mode: boolean;
  ask_ready?: boolean; // the server has a Claude API key
}

export interface Place {
  postcode: string;
  lat: number;
  lon: number;
  ward: string;
  district: string;
}

export type SectionId = "aircraft" | "helicopters" | "getting_home" | "air" | "safety" | "emergency";

export interface Point {
  value: number;
  score: number;
}

export interface Section {
  id: SectionId;
  label: string;
  night: number | null;
  day: number | null;
  headline: string;
  day_line: string;
  unit: string;
  measured: boolean;
  sample?: boolean;
  note?: string;
  hourly?: (Point | null)[];
  details?: { label: string; value: string }[];
}

export interface Crime {
  category: string;
  lat: number;
  lon: number;
  street: string;
}

export interface AirSite {
  code: string;
  name: string;
  lat: number;
  lon: number;
  index: number;
  band: string;
  pollutant: string;
}

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distance_m: number;
  lines: { id: string; name: string }[];
}

export interface Report {
  place: Place;
  radius_m: number;
  history_days: number;
  night?: { score: number; band: string };
  day?: { score: number; band: string };
  hourly?: number[];
  sections?: Section[];
  breakdown?: { category: string; label: string; count: number }[];
  getting_home?: GettingHome;
  medical?: Medical;
  layers: {
    crime?: Crime[];
    air?: AirSite[];
    stations?: Station[];
    ae?: Hospital[];
    gps?: GP[];
    utcs?: UTC[];
  };
  lines: string[];
  locked: string[];
}

export interface Aircraft {
  hex: string;
  callsign: string;
  reg: string;
  type: string;
  lat: number;
  lon: number;
  alt_ft: number;
  speed_kt: number;
  vrate_fpm: number;
  track: number;
  kind: "police" | "air_ambulance" | "helicopter" | "plane";
  t: number; // when this position was received, Unix ms
}

export interface LiveEvent {
  id: string;
  at: string;
  kind: "police" | "air_ambulance" | "emergency" | "tfl";
  text: string;
  good?: boolean;
  dist_m?: number;
}

export interface LiveSnapshot {
  now: number;
  updated: string;
  aircraft?: Aircraft[];
  aircraft_nearby: number;
  events?: LiveEvent[];
  lines?: { id: string; name: string; severity: number; status: string }[];
}

// Average aircraft per hour on a ~1 km grid, for the flight-path slider.
export interface FlightPaths {
  hours: number[]; // e.g. [21, 22, 23, 0, ..., 9]
  days: number; // days of data behind the averages
  cells: { lat: number; lon: number; h: number[] }[]; // h[i] is for hours[i]
}

export interface NightService {
  per_hour: number; // departures an hour between 1am and 5am
  approx?: boolean; // TfL's published frequency rather than a timetable
}

export interface NightOption {
  kind: "night_tube" | "night_overground" | "night_bus" | "all_night_bus";
  line: string;
  where: string;
  lat: number;
  lon: number;
  distance_m: number;
  nights: (NightService | null)[]; // Monday night first
}

export interface GettingHome {
  options: NightOption[];
  last_buses?: { route: string; stop: string; time: string }[];
}

// Weekly opening schedule: days[0] is Monday; minutes after midnight.
export interface Hours {
  open24: boolean;
  days: ({ from: number; to: number }[] | null)[];
  text: string;
}

export interface Hospital {
  name: string;
  postcode: string;
  lat: number;
  lon: number;
  distance_m: number;
}

export interface GP extends Hospital {
  code: string;
  address: string;
  phone?: string;
}

export interface UTC {
  name: string;
  site: string;
  postcode: string;
  lat: number;
  lon: number;
  distance_m: number;
  walkIn: boolean | null;
  note?: string;
  source: string;
  schedule: Hours;
}

export interface Medical {
  gps: GP[];
  gp_hours: Hours;
  gps_within_1km: number;
  utcs: UTC[];
  ae: Hospital[];
}
