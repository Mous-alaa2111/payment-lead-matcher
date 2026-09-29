// Payment-to-lead matching, ported 1:1 from stripe-crm-sync
// (matching_utils.py, match_transactions.py, match_square_transactions.py).
//
// Rules (unchanged from the proven Python):
//   - Try the primary key first; only if it finds NO contact, try the secondary key.
//   - Exactly one contact on a key -> "matched". More than one -> "ambiguous"
//     (never guessed, and never falls through to the other key).
//   - Nothing on either key -> "no_match".
//   - Stripe is email-first; Square is phone-first (every Square customer has a
//     phone, only about half have an email).
//
// Pure functions: no I/O, no env, safe to use anywhere.

export type Contact = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type MatchKey = "email" | "phone";
export type Provider = "stripe" | "square";

export type MatchResult<C extends Contact = Contact> =
  | { status: "matched"; method: MatchKey; contact: C }
  | { status: "ambiguous"; method: MatchKey; contacts: C[] }
  | { status: "no_match"; method: null };

export type ContactIndexes<C extends Contact = Contact> = {
  byEmail: Map<string, C[]>;
  byPhone: Map<string, C[]>;
};

export const PRIORITY: Record<Provider, readonly [MatchKey, MatchKey]> = {
  stripe: ["email", "phone"],
  square: ["phone", "email"],
};

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.trim().toLowerCase() || null;
}

// Strip everything but digits and '+'. Bare 10-digit numbers are assumed US
// (+1); 11 digits starting with 1 get a '+'; anything else just gets a '+'.
// Mostly a defensive pass: Stripe and GHL already store E.164.
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (!digits.startsWith("+")) {
    if (digits.length === 10) digits = "+1" + digits;
    else digits = "+" + digits; // covers the 11-digit "1..." case too
  }
  return digits;
}

// Index by email/phone -> list of contacts, since either can collide across
// multiple GHL contacts (duplicate leads, shared household phone).
export function buildContactIndexes<C extends Contact>(contacts: C[]): ContactIndexes<C> {
  const byEmail = new Map<string, C[]>();
  const byPhone = new Map<string, C[]>();
  for (const contact of contacts) {
    const email = normalizeEmail(contact.email);
    const phone = normalizePhone(contact.phone);
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), contact]);
    if (phone) byPhone.set(phone, [...(byPhone.get(phone) ?? []), contact]);
  }
  return { byEmail, byPhone };
}

export function matchTransaction<C extends Contact>(
  party: { email?: string | null; phone?: string | null },
  indexes: ContactIndexes<C>,
  priority: readonly [MatchKey, MatchKey],
): MatchResult<C> {
  const lookups: Record<MatchKey, () => C[] | undefined> = {
    email: () => {
      const key = normalizeEmail(party.email);
      return key ? indexes.byEmail.get(key) : undefined;
    },
    phone: () => {
      const key = normalizePhone(party.phone);
      return key ? indexes.byPhone.get(key) : undefined;
    },
  };

  for (const method of priority) {
    const candidates = lookups[method]();
    if (!candidates?.length) continue;
    return candidates.length === 1
      ? { status: "matched", method, contact: candidates[0] }
      : { status: "ambiguous", method, contacts: candidates };
  }
  return { status: "no_match", method: null };
}

export function contactLabel(contact: Contact) {
  const name = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "(no name)";
  return `${name} [${contact.id}]`;
}

// --- Pulling the payer's identity out of provider payloads -----------------

export type Party = { name: string | null; email: string | null; phone: string | null };

type StripeCustomerLike = { name?: string | null; email?: string | null; phone?: string | null };

// Stripe charge with `customer` expanded. Same fallbacks as build_sheet_row():
// customer email, else billing_details.email; phone only from the customer.
export function partyFromStripeCharge(charge: {
  customer?: StripeCustomerLike | string | null;
  billing_details?: { email?: string | null } | null;
}): Party {
  if (typeof charge.customer === "string") {
    throw new Error("Stripe charge.customer must be expanded (expand: ['data.customer'])");
  }
  const customer = charge.customer;
  if (customer) {
    return { name: customer.name ?? null, email: customer.email ?? null, phone: customer.phone ?? null };
  }
  return { name: null, email: charge.billing_details?.email ?? null, phone: null };
}

// Square payment plus its (separately fetched) customer, if it has one.
// Same fallbacks as classify_payments(): customer email, else buyer_email_address.
export function partyFromSquarePayment(
  payment: { buyer_email_address?: string | null },
  customer?: {
    given_name?: string | null;
    family_name?: string | null;
    email_address?: string | null;
    phone_number?: string | null;
  } | null,
): Party {
  if (customer) {
    const name = `${customer.given_name ?? ""} ${customer.family_name ?? ""}`.trim() || null;
    return {
      name,
      email: customer.email_address || payment.buyer_email_address || null,
      phone: customer.phone_number ?? null,
    };
  }
  return { name: null, email: payment.buyer_email_address ?? null, phone: null };
}

// Convenience: match one payment for a provider using that provider's priority.
export function matchPayment<C extends Contact>(provider: Provider, party: Party, indexes: ContactIndexes<C>) {
  return matchTransaction(party, indexes, PRIORITY[provider]);
}
