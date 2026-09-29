// Run: npm test
// Cases mirror what stripe-crm-sync proved: create_test_data.py,
// create_edge_case_test_data.py, test_ambiguous_match.py, and the Square
// phone-first dry run.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildContactIndexes,
  contactLabel,
  matchPayment,
  matchTransaction,
  normalizeEmail,
  normalizePhone,
  partyFromSquarePayment,
  partyFromStripeCharge,
  PRIORITY,
} from "./index";

const contacts = [
  { id: "vI1IBGyCNY3Uii07ix5N", firstName: "Jacob", lastName: "Wade", email: "JacobWade11@icloud.com", phone: "+14175550100" },
  { id: "Zj6iWGhznNmCrEjvqpZt", firstName: "Amy", lastName: "West", email: "amy@example.com", phone: "(417) 631-6585" },
  { id: "synthetic_dup_1", firstName: "Test", lastName: "DupeOne", email: "duplicate.lead@example-test.invalid", phone: null },
  { id: "synthetic_dup_2", firstName: "Test", lastName: "DupeTwo", email: "duplicate.lead@example-test.invalid", phone: null },
  { id: "house_1", firstName: "Pat", lastName: "Home", email: "pat@example.com", phone: "+14170000001" },
  { id: "house_2", firstName: "Sam", lastName: "Home", email: "sam@example.com", phone: "417-000-0001" },
];
const idx = buildContactIndexes(contacts);

describe("normalizeEmail", () => {
  it("trims and lowercases", () => assert.equal(normalizeEmail("  Foo@Bar.COM "), "foo@bar.com"));
  it("empty/missing -> null", () => {
    assert.equal(normalizeEmail(null), null);
    assert.equal(normalizeEmail(""), null);
    assert.equal(normalizeEmail("   "), null);
  });
});

describe("normalizePhone", () => {
  const cases: [string | null, string | null][] = [
    ["+14176316585", "+14176316585"],
    ["(417) 631-6585", "+14176316585"],
    ["417.631.6585", "+14176316585"],
    ["14176316585", "+14176316585"],
    ["1 (417) 631-6585", "+14176316585"],
    ["+1 417 631 6585", "+14176316585"],
    ["447911123456", "+447911123456"],
    ["12345", "+12345"],
    ["abc", null],
    ["", null],
    [null, null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => assert.equal(normalizePhone(input), expected));
  }
});

describe("buildContactIndexes", () => {
  it("indexes normalized keys and keeps collisions as lists", () => {
    assert.equal(idx.byEmail.get("jacobwade11@icloud.com")?.length, 1);
    assert.equal(idx.byEmail.get("duplicate.lead@example-test.invalid")?.length, 2);
    assert.equal(idx.byPhone.get("+14176316585")?.[0].id, "Zj6iWGhznNmCrEjvqpZt");
    assert.equal(idx.byPhone.get("+14170000001")?.length, 2);
  });
  it("skips contacts with no email/phone for that index", () => {
    assert.equal([...idx.byPhone.values()].flat().some((c) => c.id.startsWith("synthetic")), false);
  });
});

describe("Stripe (email-first)", () => {
  const match = (email: string | null, phone: string | null) => matchTransaction({ email, phone }, idx, PRIORITY.stripe);

  it("edge case 1: email matches (Jacob Wade), phone differs -> matched by email", () => {
    const r = match("jacobwade11@icloud.com", "+19995550101");
    assert.equal(r.status, "matched");
    assert.equal(r.method, "email");
    assert.equal(r.status === "matched" && r.contact.id, "vI1IBGyCNY3Uii07ix5N");
  });
  it("edge case 2: phone matches (Amy West), email missing -> matched by phone", () => {
    const r = match(null, "+14176316585");
    assert.deepEqual([r.status, r.method], ["matched", "phone"]);
  });
  it("edge case 3: nothing matches -> no_match", () => {
    assert.deepEqual(match("zoe.castellano@totally-fake-example.net", "+19995559999"), { status: "no_match", method: null });
  });
  it("test_ambiguous_match: two contacts share the email -> ambiguous with both", () => {
    const r = match("duplicate.lead@example-test.invalid", null);
    assert.equal(r.status, "ambiguous");
    assert.equal(r.method, "email");
    assert.deepEqual(new Set(r.status === "ambiguous" ? r.contacts.map((c) => c.id) : []), new Set(["synthetic_dup_1", "synthetic_dup_2"]));
  });
  it("ambiguous email does NOT fall through to a unique phone", () => {
    const r = match("duplicate.lead@example-test.invalid", "+14176316585");
    assert.deepEqual([r.status, r.method], ["ambiguous", "email"]);
  });
  it("email wins over a conflicting phone match", () => {
    const r = match("amy@example.com", "+14175550100"); // email=Amy, phone=Jacob
    assert.equal(r.status === "matched" && r.contact.id, "Zj6iWGhznNmCrEjvqpZt");
  });
  it("email match is case-insensitive", () => {
    assert.equal(match("JACOBWADE11@ICLOUD.COM", null).status, "matched");
  });
  it("unknown email falls back to phone", () => {
    assert.equal(match("nobody@example.com", "(417) 631-6585").method, "phone");
  });
});

describe("Square (phone-first)", () => {
  it("phone wins over a conflicting email match", () => {
    const r = matchPayment("square", { name: null, email: "amy@example.com", phone: "+14175550100" }, idx);
    assert.equal(r.status === "matched" && r.contact.id, "vI1IBGyCNY3Uii07ix5N");
    assert.equal(r.method, "phone");
  });
  it("shared household phone -> ambiguous by phone, no fall-through to unique email", () => {
    const r = matchPayment("square", { name: null, email: "pat@example.com", phone: "4170000001" }, idx);
    assert.deepEqual([r.status, r.method], ["ambiguous", "phone"]);
  });
  it("no phone -> falls back to email", () => {
    const r = matchPayment("square", { name: null, email: "Amy@Example.com", phone: null }, idx);
    assert.deepEqual([r.status, r.method], ["matched", "email"]);
  });
});

describe("party extraction", () => {
  it("Stripe: customer fields, no billing fallback when customer exists", () => {
    const p = partyFromStripeCharge({
      customer: { name: "Amy West", email: null, phone: "+14176316585" },
      billing_details: { email: "other@example.com" },
    });
    assert.deepEqual(p, { name: "Amy West", email: null, phone: "+14176316585" });
  });
  it("Stripe: no customer -> billing_details email, no phone", () => {
    assert.deepEqual(partyFromStripeCharge({ customer: null, billing_details: { email: "x@example.com" } }), {
      name: null,
      email: "x@example.com",
      phone: null,
    });
  });
  it("Stripe: unexpanded customer id throws", () => {
    assert.throws(() => partyFromStripeCharge({ customer: "cus_123" }));
  });
  it("Square: customer email else buyer_email_address", () => {
    const p = partyFromSquarePayment(
      { buyer_email_address: "buyer@example.com" },
      { given_name: "Amy", family_name: "West", email_address: "", phone_number: "+14176316585" },
    );
    assert.deepEqual(p, { name: "Amy West", email: "buyer@example.com", phone: "+14176316585" });
  });
  it("Square: no customer -> buyer email, no phone", () => {
    assert.deepEqual(partyFromSquarePayment({ buyer_email_address: "b@example.com" }, null), {
      name: null,
      email: "b@example.com",
      phone: null,
    });
  });
});

describe("contactLabel", () => {
  it("formats name and id", () => assert.equal(contactLabel(contacts[0]), "Jacob Wade [vI1IBGyCNY3Uii07ix5N]"));
  it("falls back to (no name)", () => assert.equal(contactLabel({ id: "x" }), "(no name) [x]"));
});
