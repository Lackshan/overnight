// The postcodes queued for comparison, kept in this browser.
export const COMPARE_LETTERS = ["A", "B", "C", "D"];
// Categorical slots 1–4 from the reference palette, validated for colour-blind
// separation in light and dark mode. Each column also wears its letter, so
// colour is never the only way to tell them apart.
export const compareColor = (i: number) => `var(--c${i + 1})`;

const KEY = "overnight.compare";

export function loadCompare(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string").map(formatPostcode).slice(0, 4) : [];
  } catch {
    return [];
  }
}

export function saveCompare(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage blocked: the list just won't persist
  }
}

// "SW111AA" -> "SW11 1AA": the inward code is always the last three characters.
export const formatPostcode = (p: string) => {
  const c = p.replace(/\s/g, "").toUpperCase();
  return c.length > 3 ? `${c.slice(0, -3)} ${c.slice(-3)}` : c;
};

export const samePostcode = (a: string, b: string) => a.replace(/\s/g, "").toUpperCase() === b.replace(/\s/g, "").toUpperCase();

export interface CompareFact {
  id: string;
  label: string;
  value: string;
  num: number;
  better: "lower" | "higher";
  estimated?: boolean;
  known: boolean;
}

export interface CompareItem {
  postcode: string;
  error?: string;
  place?: { postcode: string; lat: number; lon: number; ward: string; district: string };
  night?: { score: number; band: string };
  day?: { score: number; band: string };
  hourly?: number[];
  sections?: { id: string; label: string; night: number | null; day: number | null; headline: string; measured: boolean }[];
  facts?: CompareFact[];
}
