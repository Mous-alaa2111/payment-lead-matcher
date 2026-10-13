import type { clients } from "@/db/schema";

// Where a client stands with the agency (clients.status). Set by agency staff
// on the client page.
export type ClientStatus = (typeof clients.$inferSelect)["status"];

export const CLIENT_STATUSES: ClientStatus[] = ["active", "onboarding", "paused", "canceled"];

export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  active: "Active",
  onboarding: "Onboarding",
  paused: "Paused",
  canceled: "Canceled",
};

export const isClientStatus = (v: unknown): v is ClientStatus => CLIENT_STATUSES.includes(v as ClientStatus);
