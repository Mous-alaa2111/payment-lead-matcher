import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BACKFILL_WEEKS,
  BOOKED_RATE_THRESHOLD,
  categorize,
  clientHealth,
  createdAtMs,
  isBooked,
  isoDay,
  weekStart,
  weeksSinceLastActivity,
  weeksToFetch,
} from "./rules";

const at = (iso: string) => new Date(iso);
const wk = (...totals: (number | [number, number])[]) =>
  totals.map((t) => (Array.isArray(t) ? { total: t[0], booked: t[1] } : { total: t, booked: t }));

describe("stage keywords (weekly_report.py)", () => {
  it("booked: booked/booking, or scheduled but not 'not scheduled'/'unscheduled'", () => {
    for (const s of ["Booked", "Appointment Booked", "BOOKING CONFIRMED", "Scheduled", "Estimate scheduled", "Rescheduled"]) {
      assert.equal(isBooked(s), true, s);
    }
    for (const s of ["Not Scheduled", "Unscheduled", "New Lead", "Contacted", "", "Schedule call"]) {
      assert.equal(isBooked(s), false, s);
    }
  });

  it("categorize counts contacted, booked, won, lost and won revenue by the opportunity's current stage", () => {
    const stages = new Map([
      ["s1", "Lead Contacted"],
      ["s2", "Appointment Booked"],
      ["s3", "Not Scheduled"],
      ["s4", "Contact Made - Scheduled"],
    ]);
    const m = categorize(
      [
        { pipelineStageId: "s1", status: "open" },
        { pipelineStageId: "s2", status: "won", monetaryValue: 1250.5 },
        { pipelineStageId: "s3", status: "lost", monetaryValue: 900 },
        { pipelineStageId: "s4", status: "WON", monetaryValue: "100" },
        { pipelineStageId: "gone", status: "won", monetaryValue: null },
        { status: "abandoned" },
      ],
      stages,
    );
    assert.deepEqual(m, { total: 6, contacted: 2, booked: 2, won: 3, lost: 1, revenueCents: 135050 });
  });

  it("reads createdAt as ISO or epoch ms; unreadable is null", () => {
    assert.equal(createdAtMs("2026-10-12T10:00:00.000Z"), Date.parse("2026-10-12T10:00:00Z"));
    assert.equal(createdAtMs(1791800000000), 1791800000000);
    assert.equal(createdAtMs("1791800000000"), 1791800000000);
    assert.equal(createdAtMs("nope"), null);
    assert.equal(createdAtMs(null), null);
  });
});

describe("weeks (Monday to Sunday, UTC)", () => {
  it("week start is Monday 00:00 UTC", () => {
    assert.equal(isoDay(weekStart(at("2026-10-12T00:00:00Z"))), "2026-10-12"); // Monday
    assert.equal(isoDay(weekStart(at("2026-10-13T17:00:00Z"))), "2026-10-12");
    assert.equal(isoDay(weekStart(at("2026-10-18T23:59:59Z"))), "2026-10-12"); // Sunday
    assert.equal(isoDay(weekStart(at("2026-10-19T00:00:00Z"))), "2026-10-19");
  });

  it(`first refresh backfills the last ${BACKFILL_WEEKS} weeks, this week included`, () => {
    assert.equal(BACKFILL_WEEKS, 8);
    const weeks = weeksToFetch([], at("2026-10-13T12:00:00Z")).map(isoDay);
    assert.deepEqual(weeks, [
      "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12",
    ]);
  });

  // 8 weeks stored by a refresh at `fetched`.
  const storedAt = (fetched: string) =>
    weeksToFetch([], at(fetched)).map((d) => ({ weekStart: isoDay(d), fetchedAt: at(fetched) }));

  it("after that: this week, and last week until it's been fetched once after it ended", () => {
    const stored = storedAt("2026-10-13T12:00:00Z"); // Tuesday
    // Same week: only this week (last week was fetched after it ended, so it's frozen).
    assert.deepEqual(weeksToFetch(stored, at("2026-10-16T12:00:00Z")).map(isoDay), ["2026-10-12"]);
    // Next week: last week was fetched mid-week, so it's fetched once more; plus the new week.
    const nextWeek = at("2026-10-20T09:00:00Z");
    assert.deepEqual(weeksToFetch(stored, nextWeek).map(isoDay), ["2026-10-12", "2026-10-19"]);
    const afterThat = [
      ...stored.filter((w) => w.weekStart !== "2026-10-12"),
      { weekStart: "2026-10-12", fetchedAt: nextWeek },
      { weekStart: "2026-10-19", fetchedAt: nextWeek },
    ];
    assert.deepEqual(weeksToFetch(afterThat, at("2026-10-22T09:00:00Z")).map(isoDay), ["2026-10-19"]);
  });

  it("finished weeks are frozen: never refetched, however long ago", () => {
    const stored = storedAt("2026-10-13T12:00:00Z");
    const later = weeksToFetch(stored, at("2026-10-14T00:00:00Z")).map(isoDay);
    assert.ok(!later.includes("2026-10-05") && !later.includes("2026-08-24"));
  });

  it("weeks missed between refreshes (within the window) are filled once", () => {
    const stored = storedAt("2026-09-15T12:00:00Z"); // then nothing for four weeks
    assert.deepEqual(weeksToFetch(stored, at("2026-10-13T12:00:00Z")).map(isoDay), [
      "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12",
    ]);
  });
});

describe("client health (health_tracker.py compute_health)", () => {
  it(`booked rate threshold is ${BOOKED_RATE_THRESHOLD}%`, () => assert.equal(BOOKED_RATE_THRESHOLD, 20));

  it("this/last week, trend and booked rate come from the latest two weeks", () => {
    const h = clientHealth(wk(50, 4, [10, 3]));
    assert.equal(h.thisWeek, 10);
    assert.equal(h.lastWeek, 4);
    assert.equal(h.trend, "Up");
    assert.equal(h.bookedRateDisplay, "30%");
    assert.equal(h.weeksSince, 0);
    assert.equal(h.status, "green");
    assert.equal(clientHealth(wk(10, [5, 5])).trend, "Down");
    assert.equal(clientHealth(wk(5, [5, 5])).trend, "Flat");
  });

  it("one week: trend is 'N/A (new)', last week is empty", () => {
    const h = clientHealth(wk([4, 2]));
    assert.equal(h.trend, "N/A (new)");
    assert.equal(h.lastWeek, null);
    assert.equal(h.status, "green");
  });

  it("booked rate is N/A when this week's total is 0", () => {
    const h = clientHealth(wk(5, 0));
    assert.equal(h.bookedRate, null);
    assert.equal(h.bookedRateDisplay, "N/A");
  });

  it("booked rate rounds like Python's :.0f (half to even)", () => {
    assert.equal(clientHealth(wk([8, 1])).bookedRateDisplay, "12%"); // 12.5
    assert.equal(clientHealth(wk([8, 3])).bookedRateDisplay, "38%"); // 37.5
    assert.equal(clientHealth(wk([3, 1])).bookedRateDisplay, "33%");
  });

  it("weeks since last activity counts the most recent zero weeks in a row", () => {
    assert.equal(weeksSinceLastActivity(wk(3, 0, 0)), 2);
    assert.equal(weeksSinceLastActivity(wk(0, 3, 0)), 1);
    assert.equal(weeksSinceLastActivity(wk(0, 0)), 2);
    assert.equal(weeksSinceLastActivity([]), 0);
  });

  it("red: 2 or more weeks with no activity", () => {
    assert.equal(clientHealth(wk(9, 0, 0)).status, "red");
    assert.equal(clientHealth(wk(0, 0, 0)).status, "red");
  });

  it("yellow: this week 0, or trend Down, or booked rate under 20%", () => {
    assert.equal(clientHealth(wk(4, 0)).status, "yellow");
    assert.equal(clientHealth(wk(10, [9, 9])).status, "yellow"); // Down
    assert.equal(clientHealth(wk(10, [10, 1])).status, "yellow"); // 10%
    assert.equal(clientHealth(wk([0, 0])).status, "yellow"); // one week, 0: not yet red
  });

  it("green at exactly 20% booked, Flat or Up", () => {
    assert.equal(clientHealth(wk(10, [10, 2])).status, "green");
    assert.equal(clientHealth(wk(5, [10, 2])).status, "green");
  });

  it("grey: no data, no GHL token, or a failed refresh (never red)", () => {
    assert.deepEqual([clientHealth([]).status, clientHealth([]).label], ["grey", "No data"]);
    const noToken = clientHealth(wk(0, 0, 0), { hasToken: false });
    assert.deepEqual([noToken.status, noToken.label, noToken.thisWeek], ["grey", "No GHL token", null]);
    const failed = clientHealth(wk(0, 0, 0), { hasToken: true, error: "GHL refused the token (403)" });
    assert.deepEqual([failed.status, failed.label], ["grey", "Refresh failed"]);
  });
});
