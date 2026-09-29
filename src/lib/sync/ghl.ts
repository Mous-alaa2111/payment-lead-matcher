import type { Contact } from "@/lib/matching";

// Read-only GHL contacts listing for one location, using that location's
// Private Integration Token. Same endpoint and cursor paging as
// stripe-crm-sync's ghl_client.list_contacts().

const BASE_URL = "https://services.leadconnectorhq.com";
const CONTACTS_VERSION = "2021-07-28";
const PAGE_SIZE = 100; // GHL's max

type GhlContact = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
};

export async function listGhlContacts(locationId: string, token: string): Promise<Contact[]> {
  const contacts: Contact[] = [];
  let cursor: { startAfter: string; startAfterId: string } | null = null;

  for (;;) {
    const url = new URL("/contacts/", BASE_URL);
    url.searchParams.set("locationId", locationId);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (cursor) {
      url.searchParams.set("startAfter", cursor.startAfter);
      url.searchParams.set("startAfterId", cursor.startAfterId);
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Version: CONTACTS_VERSION },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`GHL contacts failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      contacts?: GhlContact[];
      meta?: { startAfter?: number | string; startAfterId?: string };
    };

    const page = body.contacts ?? [];
    for (const c of page) {
      contacts.push({ id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone });
    }

    const { startAfter, startAfterId } = body.meta ?? {};
    // Fewer than a full page, or no cursor to continue with -> done.
    if (page.length < PAGE_SIZE || !startAfter || !startAfterId) break;
    cursor = { startAfter: String(startAfter), startAfterId };
  }
  return contacts;
}
