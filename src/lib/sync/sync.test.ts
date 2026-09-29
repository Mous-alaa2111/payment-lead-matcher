import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SquareApi } from "./square";
import { FIRST_SYNC_DAYS, OVERLAP_DAYS, latestWindow, nextSyncedThrough, parseRange } from "./window";

const DAY = 86_400_000;
const now = new Date("2026-09-30T12:00:00Z");

describe("latestWindow", () => {
  it("first sync covers the last FIRST_SYNC_DAYS days", () => {
    const w = latestWindow(null, now);
    assert.equal(w.kind, "latest");
    assert.equal(now.getTime() - w.start.getTime(), FIRST_SYNC_DAYS * DAY);
    assert.equal(w.end, now);
  });
  it("later syncs continue from syncedThrough minus the overlap", () => {
    const through = new Date("2026-09-20T00:00:00Z");
    const w = latestWindow(through, now);
    assert.equal(through.getTime() - w.start.getTime(), OVERLAP_DAYS * DAY);
    assert.equal(w.end, now);
  });
});

describe("parseRange", () => {
  it("whole UTC days, both inclusive", () => {
    const w = parseRange("2026-01-01", "2026-01-31", now);
    assert.ok(!("error" in w));
    assert.equal(w.start.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(w.end.toISOString(), "2026-02-01T00:00:00.000Z");
    assert.equal(w.kind, "range");
  });
  it("caps an end date of today at now", () => {
    const w = parseRange("2026-09-01", "2026-09-30", now);
    assert.ok(!("error" in w));
    assert.equal(w.end.getTime(), now.getTime());
  });
  it("a single day is allowed", () => {
    const w = parseRange("2026-03-05", "2026-03-05", now);
    assert.ok(!("error" in w));
    assert.equal(w.end.getTime() - w.start.getTime(), DAY);
  });
  for (const [from, to, why] of [
    ["", "2026-01-01", "missing start"],
    ["2026-01-01", "", "missing end"],
    ["2026-02-01", "2026-01-01", "start after end"],
    ["2026-02-31", "2026-03-01", "impossible date"],
    ["01/02/2026", "2026-03-01", "wrong format"],
    ["2026-10-05", "2026-10-06", "start in the future"],
  ]) {
    it(`rejects ${why}`, () => assert.ok("error" in parseRange(from, to, now)));
  }
});

describe("nextSyncedThrough", () => {
  const through = new Date("2026-09-20T00:00:00Z");
  it("latest syncs move it to the window end", () => {
    assert.equal(nextSyncedThrough(through, latestWindow(through, now)), now);
    assert.equal(nextSyncedThrough(null, latestWindow(null, now)), now);
  });
  it("a range overlapping the covered period extends it", () => {
    const w = { kind: "range" as const, start: new Date("2026-09-01"), end: now };
    assert.equal(nextSyncedThrough(through, w), now);
  });
  it("an old backfill leaves it alone", () => {
    const w = { kind: "range" as const, start: new Date("2024-01-01"), end: new Date("2024-06-01") };
    assert.equal(nextSyncedThrough(through, w), through);
  });
  it("a range that starts after the covered period would leave a gap, so it's ignored", () => {
    const w = { kind: "range" as const, start: new Date("2026-09-25"), end: now };
    assert.equal(nextSyncedThrough(through, w), through);
  });
  it("a range never sets it for a connection that hasn't done a plain sync", () => {
    const w = { kind: "range" as const, start: new Date("2024-01-01"), end: now };
    assert.equal(nextSyncedThrough(null, w), null);
  });
});

describe("SquareApi paging", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("follows the payments cursor on every location, passing the window", async () => {
    const calls: URL[] = [];
    const pages: Record<string, { payments: object[]; cursor?: string }> = {
      "L1:": { payments: [{ id: "a", created_at: "2026-01-03" }, { id: "b", created_at: "2026-01-02" }], cursor: "c1" },
      "L1:c1": { payments: [{ id: "c", created_at: "2026-01-01" }], cursor: "c2" },
      "L1:c2": { payments: [{ id: "d", created_at: "2025-12-01" }] },
      "L2:": { payments: [{ id: "e", created_at: "2026-01-04" }] },
    };
    globalThis.fetch = (async (input: URL) => {
      calls.push(input);
      const body =
        input.pathname === "/v2/locations"
          ? { locations: [{ id: "L1", status: "ACTIVE" }, { id: "L2", status: "ACTIVE" }, { id: "L3", status: "INACTIVE" }] }
          : pages[`${input.searchParams.get("location_id")}:${input.searchParams.get("cursor") ?? ""}`];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2026-02-01T00:00:00Z");
    const got = await new SquareApi("t", true).payments(start, end);
    assert.deepEqual(got.map((p) => p.id), ["e", "a", "b", "c", "d"]); // all pages, newest first
    const paymentCalls = calls.filter((u) => u.pathname === "/v2/payments");
    assert.equal(paymentCalls.length, 4);
    for (const u of paymentCalls) {
      assert.equal(u.searchParams.get("begin_time"), start.toISOString());
      assert.equal(u.searchParams.get("end_time"), end.toISOString());
      assert.equal(u.searchParams.get("limit"), "100");
    }
    assert.ok(!paymentCalls.some((u) => u.searchParams.get("location_id") === "L3"), "inactive location skipped");
  });

  it("looks customers up 100 at a time and maps unknown ids to null", async () => {
    const batches: string[][] = [];
    globalThis.fetch = (async (_input: URL, init: RequestInit) => {
      const ids: string[] = JSON.parse(String(init.body)).customer_ids;
      batches.push(ids);
      const responses = Object.fromEntries(ids.filter((id) => id !== "gone").map((id) => [id, { customer: { given_name: id } }]));
      return new Response(JSON.stringify({ responses }), { status: 200 });
    }) as typeof fetch;

    const ids = [...Array.from({ length: 249 }, (_, i) => `c${i}`), "gone"];
    const got = await new SquareApi("t", true).customers(ids);
    assert.deepEqual(batches.map((b) => b.length), [100, 100, 50]);
    assert.equal(got.get("c248")?.given_name, "c248");
    assert.equal(got.get("gone"), null);
  });

  it("surfaces Square errors", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", detail: "bad token" }] }), { status: 401 })) as typeof fetch;
    await assert.rejects(new SquareApi("t", true).activeLocationIds(), /401 bad token/);
  });
});
