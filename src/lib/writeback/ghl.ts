import { ghlBaseUrl } from "@/lib/ghl-url";

// GHL calls for write-back, with one location's Private Integration Token.
// Reads: pipelines, a contact's tags, a contact's opportunities, one opportunity.
// Writes: update an opportunity, add or remove a contact tag. Nothing else.
// The base URL comes from lib/ghl-url (local mock only in tests).

const VERSION = "2021-07-28";
const TIMEOUT_MS = 20_000;

// GHL rate-limits per location (429). Retried after 1 s, 2 s, 4 s. Tests shrink baseMs.
export const GHL_RETRY = { attempts: 4, baseMs: 1000 };

export class GhlHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type GhlPipeline = { id: string; name: string; stages: { id: string; name: string }[] };
export type GhlOpportunity = {
  id: string;
  pipelineId: string;
  pipelineStageId: string;
  status: string;
  monetaryValue?: number | null;
  createdAt: string;
  contactId?: string;
};

export class GhlWriteApi {
  constructor(
    private locationId: string,
    private token: string,
  ) {}

  private async request<T>(method: string, path: string, opts: { params?: Record<string, string>; body?: object } = {}) {
    const url = new URL(path, ghlBaseUrl());
    for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          Version: VERSION,
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 && attempt < GHL_RETRY.attempts) {
        await new Promise((r) => setTimeout(r, GHL_RETRY.baseMs * 2 ** (attempt - 1)));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        // GHL's message only (e.g. "Opportunity not found"), never the request.
        let message = "";
        try {
          const m = (JSON.parse(text) as { message?: unknown }).message;
          message = typeof m === "string" ? m : Array.isArray(m) ? m.join("; ") : "";
        } catch {}
        throw new GhlHttpError(`GHL ${method} ${url.pathname.replace(/\/[A-Za-z0-9_-]{15,}/g, "/…")} failed: ${res.status} ${message.slice(0, 200)}`.trim(), res.status);
      }
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  async pipelines(): Promise<GhlPipeline[]> {
    const body = await this.request<{ pipelines?: GhlPipeline[] }>("GET", "/opportunities/pipelines", {
      params: { locationId: this.locationId },
    });
    return (body.pipelines ?? []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages ?? []).map((s) => ({ id: s.id, name: s.name })) }));
  }

  async contactTags(contactId: string): Promise<string[]> {
    const body = await this.request<{ contact?: { tags?: string[] } }>("GET", `/contacts/${encodeURIComponent(contactId)}`);
    return body.contact?.tags ?? [];
  }

  async opportunitiesForContact(contactId: string): Promise<GhlOpportunity[]> {
    const body = await this.request<{ opportunities?: GhlOpportunity[] }>("GET", "/opportunities/search", {
      params: { location_id: this.locationId, contact_id: contactId, limit: "100" },
    });
    return body.opportunities ?? [];
  }

  async opportunity(id: string): Promise<GhlOpportunity> {
    const body = await this.request<{ opportunity: GhlOpportunity }>("GET", `/opportunities/${encodeURIComponent(id)}`);
    return body.opportunity;
  }

  async updateOpportunity(
    id: string,
    body: { pipelineId: string; pipelineStageId: string; status: string; monetaryValue?: number },
  ) {
    await this.request("PUT", `/opportunities/${encodeURIComponent(id)}`, { body });
  }

  async addTag(contactId: string, tag: string) {
    await this.request("POST", `/contacts/${encodeURIComponent(contactId)}/tags`, { body: { tags: [tag] } });
  }

  async removeTag(contactId: string, tag: string) {
    await this.request("DELETE", `/contacts/${encodeURIComponent(contactId)}/tags`, { body: { tags: [tag] } });
  }

  // Check permissions: reads for real, and probes each write against an id that
  // can't exist, so nothing can change. GHL checks the token's scope before
  // looking the id up: 401/403 = no permission, anything else (404/400/422) = allowed.
  async checkPermissions(): Promise<{ ok: boolean; lines: string[] }> {
    const lines: string[] = [];
    let ok = true;
    const probe = async (label: string, fn: () => Promise<unknown>, write: boolean) => {
      try {
        await fn();
        lines.push(`${label}: ok`);
      } catch (err) {
        const status = err instanceof GhlHttpError ? err.status : 0;
        if (write && status && status !== 401 && status !== 403) {
          lines.push(`${label}: ok (probe answered ${status})`);
        } else {
          ok = false;
          lines.push(`${label}: refused (${status || (err as Error).message.slice(0, 80)})`);
        }
      }
    };
    await probe("Read pipelines", () => this.pipelines(), false);
    await probe("Read contacts", () => this.request("GET", "/contacts/", { params: { locationId: this.locationId, limit: "1" } }), false);
    await probe("Read opportunities", () => this.request("GET", "/opportunities/search", { params: { location_id: this.locationId, limit: "1" } }), false);
    await probe("Update opportunities", () => this.request("PUT", `/opportunities/${PROBE_ID}`, { body: {} }), true);
    await probe("Add contact tags", () => this.request("POST", `/contacts/${PROBE_ID}/tags`, { body: { tags: [] } }), true);
    return { ok, lines };
  }
}

// An id GHL can't have issued (its ids are 20 alphanumerics).
export const PROBE_ID = "pmlPermissionProbe00";
