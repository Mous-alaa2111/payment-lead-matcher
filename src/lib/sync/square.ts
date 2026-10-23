import { SQUARE_VERSION } from "@/lib/connect/square";

// Read-only Square API calls for syncing a connected seller's payments.
// Same endpoints as stripe-crm-sync's fetch_square_transactions.py, plus
// cursor paging and bulk customer lookups so there's no cap on volume.

export type SquarePayment = {
  id: string;
  created_at: string;
  status?: string;
  location_id?: string;
  customer_id?: string | null;
  buyer_email_address?: string | null;
  amount_money?: { amount?: number; currency?: string };
  refunded_money?: { amount?: number; currency?: string };
};

export type SquareCustomer = {
  given_name?: string | null;
  family_name?: string | null;
  email_address?: string | null;
  phone_number?: string | null;
};

const PAGE_LIMIT = 100; // ListPayments max
const BULK_CUSTOMERS = 100; // BulkRetrieveCustomers max

// Square answers too many requests with 429 RATE_LIMITED (it publishes no fixed
// limit). Each call is retried after 1 s, 2 s, 4 s, then the error is thrown.
// Tests shrink baseMs.
export const SQUARE_RETRY = { attempts: 4, baseMs: 1000 };

export class SquareApi {
  constructor(
    private token: string,
    private livemode: boolean,
  ) {}

  private async call<T>(path: string, init: { params?: Record<string, string>; body?: object } = {}) {
    const url = new URL(path, this.livemode ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com");
    for (const [k, v] of Object.entries(init.params ?? {})) url.searchParams.set(k, v);
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(url, {
        method: init.body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Square-Version": SQUARE_VERSION,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
      });
      if (res.status !== 429 || attempt >= SQUARE_RETRY.attempts) break;
      await new Promise((r) => setTimeout(r, SQUARE_RETRY.baseMs * 2 ** (attempt - 1)));
    }
    const body = await res.json();
    if (!res.ok) {
      const detail = body.errors?.map((e: { code: string; detail?: string }) => e.detail ?? e.code).join("; ");
      throw new Error(`Square ${url.pathname} failed: ${res.status} ${detail ?? ""}`.trim());
    }
    return body as T;
  }

  async merchant() {
    const body = await this.call<{ merchant: { id: string; business_name?: string } }>("/v2/merchants/me");
    return body.merchant;
  }

  async activeLocationIds() {
    const body = await this.call<{ locations?: { id: string; status: string }[] }>("/v2/locations");
    return (body.locations ?? []).filter((l) => l.status === "ACTIVE").map((l) => l.id);
  }

  // Every payment created in [start, end) across all active locations, newest
  // first, following the cursor until Square has no more pages.
  async payments(start: Date, end: Date) {
    const all: SquarePayment[] = [];
    for (const location_id of await this.activeLocationIds()) {
      let cursor: string | undefined;
      do {
        const body = await this.call<{ payments?: SquarePayment[]; cursor?: string }>("/v2/payments", {
          params: {
            location_id,
            begin_time: start.toISOString(),
            end_time: end.toISOString(),
            sort_order: "DESC",
            limit: String(PAGE_LIMIT),
            ...(cursor ? { cursor } : {}),
          },
        });
        all.push(...(body.payments ?? []));
        cursor = body.cursor;
      } while (cursor);
    }
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // Customers by id, 100 per request. Deleted/unknown ids map to null.
  async customers(ids: string[]) {
    const found = new Map<string, SquareCustomer | null>();
    for (let i = 0; i < ids.length; i += BULK_CUSTOMERS) {
      const chunk = ids.slice(i, i + BULK_CUSTOMERS);
      const body = await this.call<{ responses?: Record<string, { customer?: SquareCustomer }> }>(
        "/v2/customers/bulk-retrieve",
        { body: { customer_ids: chunk } },
      );
      for (const id of chunk) found.set(id, body.responses?.[id]?.customer ?? null);
    }
    return found;
  }

  // One payment, for write-back's refund re-check (status and refunded_money).
  async payment(id: string) {
    const body = await this.call<{ payment: SquarePayment }>(`/v2/payments/${encodeURIComponent(id)}`);
    return body.payment;
  }
}
