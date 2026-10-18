// Security review: a submitter's emailed reply is posted only when Resend proves the sender. A missing
// authentication result is unverified (fails closed), like forwards.
import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardSenderVerified, submitterReplyVerified } from "@/lib/email-reply";

test("missing or empty authentication results are unverified", () => {
  for (const auth of [undefined, null, {}, { spf: undefined, dkim: undefined }, { spf: "pass" }, { dkim: "pass" }]) {
    assert.equal(submitterReplyVerified(auth), false, JSON.stringify(auth));
    assert.equal(forwardSenderVerified(auth), false, JSON.stringify(auth));
  }
});

test("failures are refused", () => {
  assert.equal(submitterReplyVerified({ dmarc: "fail", spf: "pass", dkim: "pass" }), false);
  assert.equal(submitterReplyVerified({ spf: "fail", dkim: "fail" }), false);
  assert.equal(submitterReplyVerified({ dmarc: "none", spf: "pass", dkim: "fail" }), false);
  assert.equal(submitterReplyVerified({ dmarc: "temperror", spf: "pass", dkim: "pass" }), false);
});

test("DMARC pass, or SPF and DKIM both passing without a DMARC verdict, is verified", () => {
  assert.equal(submitterReplyVerified({ dmarc: "pass" }), true);
  assert.equal(submitterReplyVerified({ spf: "pass", dkim: "pass" }), true);
  assert.equal(submitterReplyVerified({ dmarc: "none", spf: "pass", dkim: "pass" }), true);
  assert.equal(forwardSenderVerified({ dmarc: "pass" }), true);
  assert.equal(forwardSenderVerified({ spf: "pass", dkim: "pass" }), false);
});
