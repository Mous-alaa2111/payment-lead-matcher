import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  uniqueIndex,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// Better Auth tables (user, session, account, verification).
// Regenerate with `npm run auth:generate`, don't hand-edit auth-schema.ts.
export * from "./auth-schema";

// A client is a business whose payments we match to leads (one per GHL
// location). Stripe/Square connections and transactions will hang off this.
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ghlLocationId: text("ghl_location_id").unique(),
  ghlTokenEnc: text("ghl_token_enc"), // location Private Integration Token, encrypted (lib/crypto)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// owner/admin = agency staff or the client's account owner; viewer = read-only.
export const clientRole = pgEnum("client_role", ["owner", "admin", "viewer"]);

// Which users can see which clients. Agency users get a row per client they
// manage; a client's own staff only get rows for their business.
export const clientMembers = pgTable(
  "client_members",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: clientRole("role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.userId] }),
    index("client_members_user_id_idx").on(t.userId),
  ],
);

// Sign-up is invite-only. The raw token only ever exists in the invite link;
// we store its SHA-256. clientId null = account only, no client membership.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(), // always stored lowercased
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    role: clientRole("role").notNull().default("viewer"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("invitations_email_idx").on(t.email)],
);

export const paymentProvider = pgEnum("payment_provider", ["stripe", "square"]);

// One Stripe and/or one Square account per client, connected via OAuth.
// Stripe: we only keep the account id and call the API with the platform key
// plus the Stripe-Account header, so no tokens are stored.
// Square: access/refresh tokens are stored AES-256-GCM encrypted (lib/crypto).
export const paymentConnections = pgTable(
  "payment_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    provider: paymentProvider("provider").notNull(),
    externalAccountId: text("external_account_id").notNull(), // acct_... / merchant id
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    livemode: boolean("livemode").notNull(),
    connectedBy: text("connected_by").references(() => user.id, { onDelete: "set null" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [uniqueIndex("payment_connections_client_provider_idx").on(t.clientId, t.provider)],
);

export const matchStatus = pgEnum("match_status", ["matched", "ambiguous", "no_match"]);
export const matchMethod = pgEnum("match_method", ["email", "phone"]);

export type MatchedContact = { id: string; name: string; email: string | null; phone: string | null };

// One row per provider payment, with the result of matching its payer against
// the client's GHL contacts. Re-syncing updates rows in place (upsert on the
// provider's payment id) so a payment is re-matched as leads change.
export const paymentMatches = pgTable(
  "payment_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    provider: paymentProvider("provider").notNull(),
    externalPaymentId: text("external_payment_id").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    paymentStatus: text("payment_status"), // provider's own status, e.g. COMPLETED / FAILED
    payerName: text("payer_name"),
    payerEmail: text("payer_email"),
    payerPhone: text("payer_phone"),
    status: matchStatus("status").notNull(),
    method: matchMethod("method"),
    contacts: jsonb("contacts").$type<MatchedContact[]>().notNull().default([]),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payment_matches_payment_idx").on(t.clientId, t.provider, t.externalPaymentId),
    index("payment_matches_client_paid_idx").on(t.clientId, t.paidAt),
  ],
);

export const clientsRelations = relations(clients, ({ many }) => ({
  members: many(clientMembers),
  invitations: many(invitations),
  paymentConnections: many(paymentConnections),
  paymentMatches: many(paymentMatches),
}));

export const clientMembersRelations = relations(clientMembers, ({ one }) => ({
  client: one(clients, { fields: [clientMembers.clientId], references: [clients.id] }),
  user: one(user, { fields: [clientMembers.userId], references: [user.id] }),
}));
