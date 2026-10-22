import assert from "node:assert/strict";
import { test } from "node:test";
import { contextHref, mayPreviewOps } from "../review/private/lib/links.ts";

test("review navigation retains the person without losing an object's query or section", () => {
  assert.equal(contextHref("/ops/sales/statements", "seller"), "/ops/sales/statements?review-as=seller");
  assert.equal(contextHref("/ops/sales/statements?seller=synthetic#lines", "owner"), "/ops/sales/statements?seller=synthetic&review-as=owner#lines");
  assert.equal(contextHref("/ops?review-as=owner", "seller"), "/ops?review-as=seller");
  assert.equal(contextHref("/agencies/a/projects", "viewer"), "/agencies/a/projects?review-as=viewer");
  for (const href of ["/__as/owner", "/__review/private", "#decision", "https://example.test/ops", "//example.test/ops", "/pricing"]) {
    assert.equal(contextHref(href, "seller"), href);
  }
});

test("seller review permits its shared sales screens and settings, never owner pages", () => {
  for (const id of ["UI33", "UI34", "UI36", "UI53", "UI54", "P-03"]) assert.equal(mayPreviewOps("seller", id), true, id);
  for (const id of ["UI35", "UI37", "UI38", "UI39", "UI40", "UI41", "UI42", "UI43", "UI44", "UI55", "P-04", "P-21", "P-22", "P-23", "P-24"]) {
    assert.equal(mayPreviewOps("seller", id), false, id);
    assert.equal(mayPreviewOps("owner", id), true, id);
  }
  for (const context of ["agency", "company", "admin", "operator", "approver", "billing", "viewer", "newcomer", "outsider"]) {
    assert.equal(mayPreviewOps(context, "UI33"), false, context);
    assert.equal(mayPreviewOps(context, "UI39"), false, context);
  }
});
