import assert from "node:assert/strict";
import { describe, it } from "node:test";

// invite-email.ts imports the database client, which only needs a URL to load (it connects lazily).
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost/unused";
const load = () => import("./invite-email");

describe("EMAIL_REPLY_TO", () => {
  it("accepts a single plain address, trimmed", async () => {
    const { replyToAddress } = await load();
    for (const v of ["team@elko.example", "first.last+tag@sub.example.co.uk", "o'neil@ex.com", "A_B-c@x-y.io"]) {
      assert.equal(replyToAddress(v), v, v);
    }
    assert.equal(replyToAddress("  team@elko.example \n"), "team@elko.example");
  });

  it("rejects missing, empty and invalid values (no Reply-To)", async () => {
    const { replyToAddress } = await load();
    const bad = [
      undefined, "", "   ", "not-an-email", "a@b", "a@b.c", "x@@y.com", "x@y..com", "x@y.com.", ".x@y.com", "x.@y.com",
      "x..y@z.com", "x@-y.com", "x@y-.com", "x@y.c0m", "a b@c.com", "Name <x@y.com>", "<x@y.com>", "x@y.com, z@w.com",
      "x@y.com;z@w.com", String.raw`\x@y.com`, '"x"@y.com', "x@y.com\r\nBcc: z@w.com", `${"a".repeat(250)}@y.com`,
    ];
    for (const v of bad) assert.equal(replyToAddress(v), undefined, JSON.stringify(v));
  });
});
