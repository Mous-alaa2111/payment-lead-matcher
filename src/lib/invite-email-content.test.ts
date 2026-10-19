import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENCY_NAME, AGENCY_STAFF_ROLE, esc, inviteEmailContent } from "./invite-email-content";

const base = {
  inviter: "Dana",
  target: "Acme Plumbing",
  role: "admin",
  url: "https://payment-lead-matcher.vercel.app/invite/tok123",
  expiresAt: new Date("2026-11-02T15:30:00Z"),
};

describe("invite email content", () => {
  it("keeps the subject and the plain-text wording", () => {
    const { subject, text } = inviteEmailContent(base);
    assert.equal(subject, "You're invited to Acme Plumbing");
    assert.equal(
      text,
      [
        "Dana invited you to Acme Plumbing on Payment Lead Matcher.",
        "Role: admin",
        "",
        "Accept the invite here:",
        base.url,
        "",
        "This link expires on November 2, 2026 at 3:30 PM UTC.",
        "If you weren't expecting this, you can ignore this email.",
      ].join("\n"),
    );
  });

  it("HTML has the heading, sentence, button link, link as text, expiry, footer and preheader", () => {
    const { html } = inviteEmailContent(base);
    assert.match(html, /You've been invited/);
    assert.match(html, /<strong[^>]*>Dana<\/strong> invited you to join <strong[^>]*>Acme Plumbing<\/strong> on Payment Lead Matcher as an admin\./);
    assert.match(html, new RegExp(`<a href="${base.url}"[^>]*>Accept invitation</a>`));
    assert.equal(html.split(base.url).length - 1, 2, "button href + plain link");
    assert.match(html, /November 2, 2026 at 3:30 PM UTC/);
    assert.match(html, /If you weren't expecting this, you can ignore this email\./);
    assert.match(html, /<div style="display:none;[^"]*">Accept your invite to Acme Plumbing<\/div>/);
    assert.match(html, /<img src="https:\/\/payment-lead-matcher\.vercel\.app\/elko-logo\.png" width="120"[^>]* alt="Elko Creative"/);
    assert.match(html, /bgcolor="#1f3a68"/);
  });

  it("HTML has no scripts, external CSS or other images", () => {
    const { html } = inviteEmailContent(base);
    assert.doesNotMatch(html, /<script|<link|<style|javascript:/i);
    assert.equal(html.match(/<img /g)?.length, 1);
    assert.equal(html.match(/<a /g)?.length, 1);
  });

  it("escapes every dynamic value in the HTML", () => {
    const { html, subject, text } = inviteEmailContent({
      ...base,
      inviter: `O'Brien <b>"Boss"</b>`,
      target: `Tom & Jerry's <script>alert(1)</script>`,
      role: `<img src=x onerror=alert(1)>`,
      url: `https://example.com/invite/a"><script>x</script>`,
    });
    assert.doesNotMatch(html, /<script|<b>|<img src=x|"><script/);
    assert.match(html, /O&#39;Brien &lt;b&gt;&quot;Boss&quot;&lt;\/b&gt;/);
    assert.match(html, /Tom &amp; Jerry&#39;s &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /as &lt;img src=x onerror=alert\(1\)&gt;\./);
    assert.match(html, /href="https:\/\/example\.com\/invite\/a&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
    // Subject and plain text are not HTML, so they stay as typed.
    assert.equal(subject, "You're invited to Tom & Jerry's <script>alert(1)</script>");
    assert.match(text, /^O'Brien <b>"Boss"<\/b> invited you to Tom & Jerry's <script>/);
  });

  it("puts the role in plain words", () => {
    const html = (role: string) => inviteEmailContent({ ...base, role }).html;
    assert.match(html("owner"), /as an owner\./);
    assert.match(html("viewer"), /as a viewer, with read-only access\./);
    assert.match(inviteEmailContent({ ...base, target: AGENCY_NAME, role: AGENCY_STAFF_ROLE }).html, /as agency staff, with access to every client\./);
  });

  it("esc covers the five HTML-special characters", () => {
    assert.equal(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  });
});
