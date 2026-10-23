import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, type WritebackConfig } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { GhlWriteApi, type GhlPipeline } from "./ghl";
import { configProblems } from "./rules";

// Staff setup of a client's write-back: Check permissions, the pipelines it
// works in, and the mode. All of it is validated here, not only in the form.

export const WRITEBACK_MODES = ["off", "preview", "auto"] as const;
export type WritebackMode = (typeof WRITEBACK_MODES)[number];
export const isWritebackMode = (v: unknown): v is WritebackMode => WRITEBACK_MODES.includes(v as WritebackMode);

async function apiFor(clientId: string) {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new Error("Client not found");
  if (!client.ghlLocationId || !client.ghlTokenEnc) throw new Error("This client has no GHL location/token set");
  return { client, ghl: new GhlWriteApi(client.ghlLocationId, decrypt(client.ghlTokenEnc)) };
}

export async function livePipelines(clientId: string): Promise<GhlPipeline[]> {
  return (await apiFor(clientId)).ghl.pipelines();
}

// Stores the result on the client. A failed check also drops an Auto client to Preview.
export async function checkPermissions(clientId: string) {
  const { client, ghl } = await apiFor(clientId);
  const { ok, lines } = await ghl.checkPermissions();
  await db
    .update(clients)
    .set({
      writebackPermsOk: ok,
      writebackPermsCheckedAt: new Date(),
      writebackPermsDetail: lines.join("\n"),
      ...(!ok && client.writebackMode === "auto" ? { writebackMode: "preview" as const } : {}),
    })
    .where(eq(clients.id, clientId));
  return { ok, lines };
}

// From the setup form: per live pipeline, include_<id>, closed_<id> (stage id), tags_<id> (comma-separated).
export function configFromForm(form: FormData, pipelines: GhlPipeline[]): WritebackConfig | { error: string } {
  const chosen: WritebackConfig["pipelines"] = [];
  for (const p of pipelines) {
    if (form.get(`include_${p.id}`) !== "on") continue;
    const stage = p.stages.find((s) => s.id === form.get(`closed_${p.id}`));
    if (!stage) return { error: `Pick the Closed stage for "${p.name}".` };
    const tags = String(form.get(`tags_${p.id}`) ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    chosen.push({ id: p.id, name: p.name, closedStageId: stage.id, closedStageName: stage.name, contradictTags: [...new Set(tags)] });
  }
  if (!chosen.length) return { error: "Pick at least one pipeline." };
  return { pipelines: chosen };
}

export async function saveConfig(clientId: string, config: WritebackConfig) {
  const problems = configProblems(config, await livePipelines(clientId));
  if (problems.length) throw new Error(problems.join(" "));
  await db.update(clients).set({ writebackConfig: config }).where(eq(clients.id, clientId));
}

// Off is always allowed. Preview needs a setup; Auto also needs a passed Check permissions.
export async function setMode(clientId: string, mode: WritebackMode): Promise<string | null> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) return "Client not found";
  if (mode !== "off" && !client.writebackConfig?.pipelines.length) return "Set up the pipelines first.";
  if (mode === "auto" && !client.writebackPermsOk) return "Run Check permissions first; Auto needs it to pass.";
  await db.update(clients).set({ writebackMode: mode }).where(eq(clients.id, clientId));
  return null;
}
