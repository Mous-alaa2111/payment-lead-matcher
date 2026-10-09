import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AUTO_SYNC_CRON_HOUR_UTC,
  AUTO_SYNC_EVERY_DAYS,
  autoSyncBlocker,
  autoSyncDueFrom,
  isAutoSyncDue,
  nextAutoSync,
  nextCronRun,
} from "./schedule";

const at = (iso: string) => new Date(iso);
const synced = (...isos: (string | null)[]) => isos.map((s) => ({ lastSyncedAt: s ? at(s) : null }));

describe("auto sync schedule", () => {
  it("vercel.json runs the cron daily at AUTO_SYNC_CRON_HOUR_UTC", () => {
    const { crons } = JSON.parse(readFileSync("vercel.json", "utf8"));
    assert.deepEqual(crons, [{ path: "/api/cron/auto-sync", schedule: `0 ${AUTO_SYNC_CRON_HOUR_UTC} * * *` }]);
  });

  it("is due from AUTO_SYNC_EVERY_DAYS whole UTC days after the oldest account's last sync", () => {
    assert.equal(AUTO_SYNC_EVERY_DAYS, 14);
    const conns = synced("2026-10-01T06:40:00Z", "2026-10-05T12:00:00Z");
    assert.equal(autoSyncDueFrom(conns)!.toISOString(), "2026-10-15T00:00:00.000Z");
    assert.equal(isAutoSyncDue(conns, at("2026-10-14T23:59:00Z")), false);
    // The cron fires earlier in the hour than the last sync ended: still due on day 14.
    assert.equal(isAutoSyncDue(conns, at("2026-10-15T06:05:00Z")), true);
  });

  it("an account that never synced makes the client due now", () => {
    assert.equal(autoSyncDueFrom(synced("2026-10-08T00:00:00Z", null)), null);
    assert.equal(isAutoSyncDue(synced(null), at("2026-10-09T00:00:00Z")), true);
  });

  it("the interval is a parameter", () => {
    const conns = synced("2026-10-01T10:00:00Z");
    assert.equal(isAutoSyncDue(conns, at("2026-10-04T06:00:00Z"), 3), true);
    assert.equal(isAutoSyncDue(conns, at("2026-10-04T06:00:00Z"), 4), false);
  });

  it("next cron run is the top of the cron hour, today or tomorrow", () => {
    assert.equal(nextCronRun(at("2026-10-09T05:59:00Z")).toISOString(), "2026-10-09T06:00:00.000Z");
    assert.equal(nextCronRun(at("2026-10-09T06:00:00Z")).toISOString(), "2026-10-09T06:00:00.000Z");
    assert.equal(nextCronRun(at("2026-10-09T06:01:00Z")).toISOString(), "2026-10-10T06:00:00.000Z");
  });

  it("next auto sync: the run on the due day, or the next run if already due", () => {
    const now = at("2026-10-09T12:00:00Z");
    assert.equal(nextAutoSync(synced("2026-10-09T06:20:00Z"), now).toISOString(), "2026-10-23T06:00:00.000Z");
    assert.equal(nextAutoSync(synced("2026-09-01T00:00:00Z"), now).toISOString(), "2026-10-10T06:00:00.000Z");
    assert.equal(nextAutoSync(synced(null), now).toISOString(), "2026-10-10T06:00:00.000Z");
  });

  it("needs a connected account and a GHL token", () => {
    const ghl = { ghlLocationId: "loc", ghlTokenEnc: "enc" };
    assert.match(autoSyncBlocker(ghl, [])!, /connect Stripe or Square/);
    assert.match(autoSyncBlocker({ ghlLocationId: "loc", ghlTokenEnc: null }, synced(null))!, /GHL token/);
    assert.equal(autoSyncBlocker(ghl, synced(null)), null);
  });
});
