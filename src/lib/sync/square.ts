import { SQUARE_VERSION } from "@/lib/connect/square";

// Read-only Square API calls for syncing a connected seller's payments.
// Same endpoints as stripe-crm-sync's fetch_square_transactions.py.

export type SquarePayment = {
  id: string;
  created_at: string;
  status?: string;
  location_id?: string;
  customer_id?: string | null;
  buyer_email_address?: string | null;
  amount_money?: { amount?: number; currency?: string };
};

export type SquareCustomer = {
  given_name?: string | null;
  family_name?: string | null;
  email_address?: string | null;
  phone_number?: string | null;
};

export class SquareApi {
  constructor(
    private token: string,
    private livemode: boolean,
  ) {}

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const url = new URL(path, this.livemode ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}`, "Square-Version": SQUARE_VERSION, Accept: "application/json" },
      cache: "no-store",
    });
    const body = await res.json();
    if (!res.ok && res.status !== 404) {
      const detail = body.errors?.map((e: { code: string; detail?: string }) => e.detail ?? e.code).join("; ");
      throw new Error(`Square GET ${url.pathname} failed: ${res.status} ${detail ?? ""}`.trim());
    }
    return { status: res.status, body };
  }

  async merchant() {
    const { body } = await this.get<{ merchant: { id: string; business_name?: string } }>("/v2/merchants/me");
    return body.merchant;
  }

  async activeLocationIds() {
    const { body } = await this.get<{ locations?: { id: string; status: string }[] }>("/v2/locations");
    return (body.locations ?? []).filter((l) => l.status === "ACTIVE").map((l) => l.id);
  }

  // Most recent `limit` payments (max 100) across all active locations, newest first.
  async recentPayments(limit: number) {
    const perLocation = await Promise.all(
      (await this.activeLocationIds()).map(async (location_id) => {
        const { body } = await this.get<{ payments?: SquarePayment[] }>("/v2/payments", {
          location_id,
          sort_order: "DESC",
          limit: String(Math.min(limit, 100)),
        });
        return body.payments ?? [];
      }),
    );
    return perLocation
      .flat()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  // null if the customer was deleted since the payment.
  async customer(id: string) {
    const { status, body } = await this.get<{ customer?: SquareCustomer }>(`/v2/customers/${encodeURIComponent(id)}`);
    return status === 404 ? null : (body.customer ?? null);
  }
}
