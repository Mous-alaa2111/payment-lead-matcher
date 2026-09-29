import { relations } from "drizzle-orm";
import {
  index,
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

export const clientsRelations = relations(clients, ({ many }) => ({
  members: many(clientMembers),
}));

export const clientMembersRelations = relations(clientMembers, ({ one }) => ({
  client: one(clients, { fields: [clientMembers.clientId], references: [clients.id] }),
  user: one(user, { fields: [clientMembers.userId], references: [user.id] }),
}));
