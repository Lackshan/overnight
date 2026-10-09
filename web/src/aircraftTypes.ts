// Common aircraft by ICAO type designator: display name, silhouette family,
// wingspan and length in metres (rotor diameter and overall length for
// helicopters). Used to draw each aircraft top-down at its real relative size.

export type Family =
  | "narrow" // twin jet, engines under swept wings (A320, 737)
  | "wide" // big twin jet (A350, 787, 777)
  | "quad" // four jets (A380, 747)
  | "rearjet" // engines on the rear fuselage, T-tail (CRJ, business jets)
  | "turboprop" // twin props, straight wings (ATR, Dash 8)
  | "quadprop" // four props (A400M, C-130)
  | "single" // one propeller in the nose (Cessna, Piper, PC-12)
  | "twinpiston" // small twin props (Baron, DA42)
  | "heli";

export interface AircraftType {
  name: string;
  family: Family;
  span: number;
  length: number;
}

const T = (name: string, family: Family, span: number, length: number): AircraftType => ({ name, family, span, length });

export const TYPES: Record<string, AircraftType> = {
  // Airbus narrowbodies
  A318: T("Airbus A318", "narrow", 34.1, 31.4),
  A319: T("Airbus A319", "narrow", 35.8, 33.8),
  A320: T("Airbus A320", "narrow", 35.8, 37.6),
  A321: T("Airbus A321", "narrow", 35.8, 44.5),
  A19N: T("Airbus A319neo", "narrow", 35.8, 33.8),
  A20N: T("Airbus A320neo", "narrow", 35.8, 37.6),
  A21N: T("Airbus A321neo", "narrow", 35.8, 44.5),
  BCS1: T("Airbus A220-100", "narrow", 35.1, 35.0),
  BCS3: T("Airbus A220-300", "narrow", 35.1, 38.7),
  // Boeing narrowbodies
  B736: T("Boeing 737-600", "narrow", 34.3, 31.2),
  B737: T("Boeing 737-700", "narrow", 34.3, 33.6),
  B738: T("Boeing 737-800", "narrow", 35.8, 39.5),
  B739: T("Boeing 737-900", "narrow", 35.8, 42.1),
  B37M: T("Boeing 737 MAX 7", "narrow", 35.9, 35.6),
  B38M: T("Boeing 737 MAX 8", "narrow", 35.9, 39.5),
  B39M: T("Boeing 737 MAX 9", "narrow", 35.9, 42.2),
  B3XM: T("Boeing 737 MAX 10", "narrow", 35.9, 43.8),
  B752: T("Boeing 757-200", "narrow", 38.0, 47.3),
  B753: T("Boeing 757-300", "narrow", 38.0, 54.4),
  // Embraer E-Jets
  E170: T("Embraer 170", "narrow", 26.0, 29.9),
  E75S: T("Embraer 175", "narrow", 26.0, 31.7),
  E75L: T("Embraer 175", "narrow", 28.7, 31.7),
  E190: T("Embraer 190", "narrow", 28.7, 36.2),
  E195: T("Embraer 195", "narrow", 28.7, 38.7),
  E290: T("Embraer E190-E2", "narrow", 33.7, 36.2),
  E295: T("Embraer E195-E2", "narrow", 35.1, 41.5),
  // Airbus widebodies
  A306: T("Airbus A300-600", "wide", 44.8, 54.1),
  A310: T("Airbus A310", "wide", 43.9, 46.7),
  A332: T("Airbus A330-200", "wide", 60.3, 58.8),
  A333: T("Airbus A330-300", "wide", 60.3, 63.7),
  A338: T("Airbus A330-800neo", "wide", 64.0, 58.8),
  A339: T("Airbus A330-900neo", "wide", 64.0, 63.7),
  A359: T("Airbus A350-900", "wide", 64.8, 66.8),
  A35K: T("Airbus A350-1000", "wide", 64.8, 73.8),
  A343: T("Airbus A340-300", "quad", 60.3, 63.7),
  A346: T("Airbus A340-600", "quad", 63.5, 75.3),
  A388: T("Airbus A380", "quad", 79.8, 72.7),
  // Boeing widebodies
  B762: T("Boeing 767-200", "wide", 47.6, 48.5),
  B763: T("Boeing 767-300", "wide", 47.6, 54.9),
  B764: T("Boeing 767-400", "wide", 51.9, 61.4),
  B772: T("Boeing 777-200", "wide", 60.9, 63.7),
  B77L: T("Boeing 777-200LR", "wide", 64.8, 63.7),
  B77W: T("Boeing 777-300ER", "wide", 64.8, 73.9),
  B778: T("Boeing 777-8", "wide", 71.8, 70.9),
  B779: T("Boeing 777-9", "wide", 71.8, 76.7),
  B788: T("Boeing 787-8", "wide", 60.1, 56.7),
  B789: T("Boeing 787-9", "wide", 60.1, 62.8),
  B78X: T("Boeing 787-10", "wide", 60.1, 68.3),
  B744: T("Boeing 747-400", "quad", 64.4, 70.7),
  B748: T("Boeing 747-8", "quad", 68.4, 76.3),
  // Regional and business jets with rear engines
  CRJ2: T("Bombardier CRJ200", "rearjet", 21.2, 26.8),
  CRJ7: T("Bombardier CRJ700", "rearjet", 23.2, 32.5),
  CRJ9: T("Bombardier CRJ900", "rearjet", 24.9, 36.2),
  CRJX: T("Bombardier CRJ1000", "rearjet", 26.2, 39.1),
  E135: T("Embraer ERJ 135", "rearjet", 20.0, 26.3),
  E145: T("Embraer ERJ 145", "rearjet", 20.0, 29.9),
  E35L: T("Embraer Legacy 600", "rearjet", 21.2, 26.3),
  E50P: T("Embraer Phenom 100", "rearjet", 12.3, 12.8),
  E55P: T("Embraer Phenom 300", "rearjet", 16.2, 15.6),
  E545: T("Embraer Praetor 500", "rearjet", 20.3, 19.7),
  E550: T("Embraer Praetor 600", "rearjet", 21.5, 20.7),
  C25A: T("Cessna Citation CJ2", "rearjet", 15.5, 14.5),
  C25B: T("Cessna Citation CJ3", "rearjet", 16.3, 15.6),
  C25C: T("Cessna Citation CJ4", "rearjet", 15.5, 16.3),
  C56X: T("Cessna Citation Excel", "rearjet", 17.2, 15.8),
  C68A: T("Cessna Citation Latitude", "rearjet", 22.0, 19.2),
  C700: T("Cessna Citation Longitude", "rearjet", 21.0, 22.3),
  CL30: T("Bombardier Challenger 300", "rearjet", 19.5, 20.9),
  CL35: T("Bombardier Challenger 350", "rearjet", 21.0, 20.9),
  CL60: T("Bombardier Challenger 600", "rearjet", 19.6, 20.9),
  GL5T: T("Bombardier Global 5000", "rearjet", 28.7, 29.5),
  GLEX: T("Bombardier Global Express", "rearjet", 28.6, 30.3),
  GL7T: T("Bombardier Global 7500", "rearjet", 31.7, 33.8),
  GLF4: T("Gulfstream G450", "rearjet", 23.7, 27.2),
  GLF5: T("Gulfstream G550", "rearjet", 28.5, 29.4),
  GLF6: T("Gulfstream G650", "rearjet", 30.4, 30.4),
  G280: T("Gulfstream G280", "rearjet", 19.2, 20.4),
  F2TH: T("Dassault Falcon 2000", "rearjet", 19.3, 20.2),
  F900: T("Dassault Falcon 900", "rearjet", 19.3, 20.2),
  FA7X: T("Dassault Falcon 7X", "rearjet", 26.2, 23.2),
  FA8X: T("Dassault Falcon 8X", "rearjet", 26.3, 24.5),
  LJ45: T("Learjet 45", "rearjet", 14.6, 17.7),
  LJ75: T("Learjet 75", "rearjet", 15.5, 17.7),
  PC24: T("Pilatus PC-24", "rearjet", 17.0, 16.9),
  H25B: T("Hawker 800", "rearjet", 15.7, 15.6),
  HDJT: T("HondaJet", "rearjet", 12.1, 12.7),
  // Turboprops
  AT43: T("ATR 42-300", "turboprop", 24.6, 22.7),
  AT45: T("ATR 42-500", "turboprop", 24.6, 22.7),
  AT46: T("ATR 42-600", "turboprop", 24.6, 22.7),
  AT72: T("ATR 72", "turboprop", 27.1, 27.2),
  AT75: T("ATR 72-500", "turboprop", 27.1, 27.2),
  AT76: T("ATR 72-600", "turboprop", 27.1, 27.2),
  DH8A: T("De Havilland Dash 8-100", "turboprop", 25.9, 22.3),
  DH8C: T("De Havilland Dash 8-300", "turboprop", 27.4, 25.7),
  DH8D: T("De Havilland Dash 8-400", "turboprop", 28.4, 32.8),
  SF34: T("Saab 340", "turboprop", 21.4, 19.7),
  SB20: T("Saab 2000", "turboprop", 24.8, 27.3),
  JS41: T("BAe Jetstream 41", "turboprop", 18.3, 19.3),
  D328: T("Dornier 328", "turboprop", 21.0, 21.3),
  B350: T("Beechcraft King Air 350", "turboprop", 17.6, 14.2),
  BE20: T("Beechcraft King Air 200", "turboprop", 16.6, 13.3),
  BE9L: T("Beechcraft King Air 90", "turboprop", 15.3, 10.8),
  P180: T("Piaggio P.180 Avanti", "turboprop", 14.0, 14.4),
  A400: T("Airbus A400M", "quadprop", 42.4, 45.1),
  C130: T("Lockheed C-130 Hercules", "quadprop", 40.4, 29.8),
  C30J: T("Lockheed C-130J Hercules", "quadprop", 40.4, 34.4),
  // Single-engine props
  C150: T("Cessna 150", "single", 10.1, 7.3),
  C152: T("Cessna 152", "single", 10.1, 7.3),
  C172: T("Cessna 172", "single", 11.0, 8.3),
  C182: T("Cessna 182", "single", 11.0, 8.8),
  C208: T("Cessna Caravan", "single", 15.9, 11.5),
  P28A: T("Piper PA-28 Cherokee", "single", 10.7, 7.3),
  P28R: T("Piper Arrow", "single", 10.8, 7.5),
  PA46: T("Piper Malibu", "single", 13.1, 8.8),
  SR20: T("Cirrus SR20", "single", 11.7, 7.9),
  SR22: T("Cirrus SR22", "single", 11.7, 7.9),
  DA40: T("Diamond DA40", "single", 11.9, 8.0),
  PC12: T("Pilatus PC-12", "single", 16.3, 14.4),
  TBM9: T("Daher TBM 900", "single", 12.8, 10.7),
  TBM7: T("Daher TBM 700", "single", 12.7, 10.6),
  // Twin piston
  DA42: T("Diamond DA42", "twinpiston", 13.4, 8.6),
  DA62: T("Diamond DA62", "twinpiston", 14.6, 9.2),
  BE58: T("Beechcraft Baron", "twinpiston", 11.5, 9.1),
  PA34: T("Piper Seneca", "twinpiston", 11.9, 8.7),
  P68: T("Partenavia P.68", "twinpiston", 12.0, 9.4),
  // Helicopters: rotor diameter, overall length
  EC35: T("Airbus H135", "heli", 10.2, 12.2),
  EXPL: T("MD Explorer", "heli", 10.3, 11.8),
  MD90: T("MD Explorer", "heli", 10.3, 11.8),
  EC45: T("Airbus H145", "heli", 11.0, 13.6),
  H145: T("Airbus H145", "heli", 11.0, 13.6),
  EC30: T("Airbus H130", "heli", 10.7, 12.6),
  EC55: T("Airbus H155", "heli", 12.6, 14.3),
  EC75: T("Airbus H175", "heli", 14.8, 18.1),
  AS50: T("Airbus AS350 Écureuil", "heli", 10.7, 12.9),
  AS65: T("Airbus AS365 Dauphin", "heli", 11.9, 13.7),
  A109: T("Leonardo AW109", "heli", 11.0, 13.0),
  A139: T("Leonardo AW139", "heli", 13.8, 16.7),
  A169: T("Leonardo AW169", "heli", 12.1, 14.7),
  A189: T("Leonardo AW189", "heli", 14.6, 17.6),
  EH10: T("AgustaWestland AW101 Merlin", "heli", 18.6, 22.8),
  S76: T("Sikorsky S-76", "heli", 13.4, 16.0),
  S92: T("Sikorsky S-92", "heli", 17.2, 20.9),
  H60: T("Sikorsky Black Hawk", "heli", 16.4, 19.8),
  H47: T("Boeing Chinook", "heli", 18.3, 30.1),
  R22: T("Robinson R22", "heli", 7.7, 8.8),
  R44: T("Robinson R44", "heli", 10.1, 11.7),
  R66: T("Robinson R66", "heli", 10.1, 11.6),
  B06: T("Bell 206 JetRanger", "heli", 10.2, 11.9),
  B407: T("Bell 407", "heli", 10.7, 12.7),
  B429: T("Bell 429", "heli", 11.0, 13.1),
};

const FALLBACK_PLANE = T("", "narrow", 34, 36);
const FALLBACK_HELI = T("", "heli", 11, 13);

export function typeOf(designator: string, isHeli: boolean): AircraftType {
  const t = TYPES[designator?.toUpperCase()];
  if (t) return t;
  return isHeli ? FALLBACK_HELI : FALLBACK_PLANE;
}
