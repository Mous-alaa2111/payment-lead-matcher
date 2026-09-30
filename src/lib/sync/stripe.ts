// Read-only Stripe API calls for syncing a connected account's payments.
// Same data as stripe-crm-sync's match_transactions.py (charges with the
// customer expanded), plus created-date windows and cursor paging.
//
// Credentials: a Connect account is read with the platform key
// (STRIPE_SECRET_KEY) plus the Stripe-Account header; a manually seeded
// connection instead stores that account's own secret key (no header).

export type StripeCustomer = {
  id: string;
  deleted?: boolean;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type StripeCharge = {
  id: string;
  created: number; // unix seconds
  amount: number; // minor units
  currency: string; // lowercase ISO code
  status: "succeeded" | "pending" | "failed";
  refunded?: boolean;
  amount_refunded?: number;
  customer?: StripeCustomer | string | null;
  billing_details?: { name?: string | null; email?: string | null } | null;
};

const PAGE_LIMIT = 100; // list endpoints' max
const API = "https://api.stripe.com";

// Square-style statuses, so the table treats both providers the same
// ("COMPLETED" shows no status line).
export function stripeChargeStatus(c: Pick<StripeCharge, "status" | "refunded" | "amount_refunded">) {
  if (c.refunded) return "REFUNDED";
  if ((c.amount_refunded ?? 0) > 0) return "PARTIALLY_REFUNDED";
  return { succeeded: "COMPLETED", pending: "PENDING", failed: "FAILED" }[c.status] ?? c.status.toUpperCase();
}

export class StripeApi {
  constructor(
    private secretKey: string,
    private account: string | null, // acct_... for Connect; null when secretKey is the account's own key
  ) {}

  private async get<T>(path: string, params: [string, string][]) {
    const url = new URL(path, API);
    for (const [k, v] of params) url.searchParams.append(k, v);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(this.account ? { "Stripe-Account": this.account } : {}),
      },
      cache: "no-store",
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Stripe ${url.pathname} failed: ${res.status} ${body.error?.message ?? ""}`.trim());
    return body as T;
  }

  async accountInfo() {
    return this.get<{ id: string; business_profile?: { name?: string | null } }>("/v1/account", []);
  }

  // Every charge created in [start, end), newest first, customer expanded.
  async charges(start: Date, end: Date) {
    const all: StripeCharge[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const body = await this.get<{ data: StripeCharge[]; has_more: boolean }>("/v1/charges", [
        ["limit", String(PAGE_LIMIT)],
        ["created[gte]", String(Math.floor(start.getTime() / 1000))],
        ["created[lt]", String(Math.ceil(end.getTime() / 1000))],
        ["expand[]", "data.customer"],
        ...(startingAfter ? ([["starting_after", startingAfter]] as [string, string][]) : []),
      ]);
      all.push(...body.data);
      if (!body.has_more || body.data.length === 0) break;
      startingAfter = body.data.at(-1)!.id;
    }
    return all;
  }
}
