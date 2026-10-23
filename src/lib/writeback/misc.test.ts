import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ghlBaseUrl, REAL_GHL_URL } from "@/lib/ghl-url";
import { SQUARE_RETRY, SquareApi } from "@/lib/sync/square";
import { summaryContent } from "./email-content";
import type { RunOutcome } from "./run";

const env = { ...process.env };
const realFetch = globalThis.fetch;
afterEach(() => {
  process.env = { ...env };
  globalThis.fetch = realFetch;
});

describe("ghlBaseUrl", () => {
  it("is real GHL by default", () => {
    delete process.env.GHL_API_URL;
    delete process.env.E2E_NO_REAL_GHL;
    assert.equal(ghlBaseUrl(), REAL_GHL_URL);
  });
  it("takes a localhost override only", () => {
    process.env.GHL_API_URL = "http://localhost:4020";
    assert.equal(ghlBaseUrl(), "http://localhost:4020");
    process.env.GHL_API_URL = "https://evil.example.com";
    assert.throws(() => ghlBaseUrl(), /localhost/);
  });
  it("refuses real GHL in an e2e run", () => {
    process.env.E2E_NO_REAL_GHL = "1";
    delete process.env.GHL_API_URL;
    assert.throws(() => ghlBaseUrl(), /refusing to call real GHL/);
    process.env.GHL_API_URL = "http://127.0.0.1:4020";
    assert.equal(ghlBaseUrl(), "http://127.0.0.1:4020");
  });
});

describe("Square 429 retry", () => {
  it("retries with backoff, then succeeds", async () => {
    SQUARE_RETRY.baseMs = 1;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 3
        ? new Response(JSON.stringify({ errors: [{ code: "RATE_LIMITED" }] }), { status: 429 })
        : new Response(JSON.stringify({ payment: { id: "p1", status: "COMPLETED" } }), { status: 200 });
    }) as typeof fetch;
    const p = await new SquareApi("t", false).payment("p1");
    assert.equal(p.status, "COMPLETED");
    assert.equal(calls, 3);
  });
  it("gives up after SQUARE_RETRY.attempts", async () => {
    SQUARE_RETRY.baseMs = 1;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ errors: [{ code: "RATE_LIMITED", detail: "slow down" }] }), { status: 429 });
    }) as typeof fetch;
    await assert.rejects(new SquareApi("t", false).payment("p1"), /429 slow down/);
    assert.equal(calls, SQUARE_RETRY.attempts);
  });
});

describe("write-back summary email", () => {
  const outcome = (over: Partial<RunOutcome>): RunOutcome => ({
    clientId: "c", runId: "r", applied: true, status: "ok", planned: 0, updated: 0, skipped: {}, newNeedsReview: 0, ...over,
  });
  it("lists only clients where something happened, as counts with a link", () => {
    const c = summaryContent(
      [
        outcome({ clientId: "a", updated: 2, skipped: { "already Closed": 3 } }),
        outcome({ clientId: "b" }),
        outcome({ clientId: "c", status: "error", error: "GHL said no for Jane Doe $150" }),
      ],
      "daily cron",
      (id) => `https://app.test/dashboard/clients/${id}`,
    );
    assert.equal(c.subject, "GHL write-back: 2 updated, 1 with errors");
    assert.match(c.text, /Client 1: 2 updated, 3 skipped\nhttps:\/\/app.test\/dashboard\/clients\/a/);
    assert.match(c.text, /Client 2: 0 updated, 0 skipped, stopped on an error/);
    assert.ok(!c.text.includes("/clients/b"));
    // Error text can carry names or amounts: it stays on the client page.
    assert.ok(!c.text.includes("Jane") && !c.text.includes("$") && !c.html.includes("Jane") && !c.html.includes("$"));
  });
});
