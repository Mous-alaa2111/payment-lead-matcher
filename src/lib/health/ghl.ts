import { createdAtMs, type Opportunity } from "./rules";
import { ghlBaseUrl } from "@/lib/ghl-url";

// Read-only GHL opportunities for one location, using that location's Private
// Integration Token. Same endpoints and paging as the GHL CLI's
// weekly_report.py get_stage_map() / get_opportunities().

const VERSION = "2021-07-28";
const PAGE_SIZE = 100;

// A 401/403: the token doesn't grant opportunities access (the stored tokens
// were only ever checked against contacts). Shown on the client, never red.
export class GhlAccessError extends Error {}

async function get<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const url = new URL(path, ghlBaseUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Version: VERSION },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new GhlAccessError(`GHL ${path} refused the token (${res.status}): it may not have opportunities access. ${body}`.trim());
    }
    throw new Error(`GHL ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

// {stage id: stage name} across all of the location's pipelines.
export async function getStageMap(locationId: string, token: string): Promise<Map<string, string>> {
  const body = await get<{ pipelines?: { stages?: { id: string; name: string }[] }[] }>(
    "/opportunities/pipelines",
    { locationId },
    token,
  );
  const map = new Map<string, string>();
  for (const p of body.pipelines ?? []) for (const s of p.stages ?? []) map.set(s.id, s.name);
  return map;
}

// Opportunities created in [startMs, endMs). Pages newest-first and stops at
// the first one older than the window, as the Python does.
export async function getOpportunities(locationId: string, token: string, startMs: number, endMs: number) {
  const results: Opportunity[] = [];
  for (let page = 1; ; page++) {
    const body = await get<{ opportunities?: Opportunity[]; meta?: { total?: number } }>(
      "/opportunities/search",
      { location_id: locationId, limit: String(PAGE_SIZE), page: String(page) },
      token,
    );
    const opps = body.opportunities ?? [];
    if (!opps.length) break;

    let pastWindow = false;
    for (const opp of opps) {
      const ts = createdAtMs(opp.createdAt);
      if (ts === null) continue;
      if (ts < startMs) {
        pastWindow = true;
        break;
      }
      if (ts < endMs) results.push(opp);
    }
    if (pastWindow || page * PAGE_SIZE >= (body.meta?.total ?? 0)) break;
  }
  return results;
}
