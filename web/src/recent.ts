// Recent searches. Guests' live in this browser; signed-in users' are saved
// to their account (and a guest's are merged in when they sign in).
import { api } from "./api";

export interface RecentSearch {
  postcode: string;
  area: string;
  lat: number;
  lon: number;
  night_score?: number;
  at: string; // ISO time
}

const KEY = "overnight.recent";

function readLocal(): RecentSearch[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeLocal(list: RecentSearch[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // private browsing or storage full: recents just won't persist
  }
}

export function addLocal(r: RecentSearch, limit: number): RecentSearch[] {
  const list = [r, ...readLocal().filter((x) => x.postcode !== r.postcode)].slice(0, limit);
  writeLocal(list);
  return list;
}

export function removeLocal(postcode: string | null): RecentSearch[] {
  const list = postcode ? readLocal().filter((x) => x.postcode !== postcode) : [];
  writeLocal(list);
  return list;
}

export const localRecents = (limit: number) => readLocal().slice(0, limit);

// On sign-in: push anything searched as a guest to the account, then use the account's list.
export async function syncOnSignIn(): Promise<RecentSearch[]> {
  const local = readLocal();
  const res = local.length ? await api.addRecent({ items: local }) : await api.recent();
  writeLocal([]);
  return res.recent;
}
