// The sentence the Pricing estimator shows for a number of billable source units (A3 3.4: every price on the page is an indicative band; the
// server's quote is the price; an estimate reserves nothing). The words are chosen here, in a pure function, so the client component only
// shows them. What must hold: a price is shown only for a band that is offered, a mode that is not available is said not to be, and no
// sentence reads as a quote.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEstimate } from "../src/public/estimate-text.ts";

test("nothing typed is a prompt, and text that is not a number of units is an error the visitor can fix", () => {
  assert.deepEqual(describeEstimate("", "CLEAN", "AVAILABLE"), { kind: "EMPTY", text: "Enter a number to see the indicative band.", notes: [] });
  assert.equal(describeEstimate("   ", "CLEAN", "AVAILABLE").kind, "EMPTY");
  for (const text of ["abc", "12.5", "-4", "1e6", "4 2 0 a", "1,000,000,000,000,000"]) {
    assert.deepEqual(describeEstimate(text, "CLEAN", "AVAILABLE"), { kind: "INVALID", text: "Enter a whole number of units, such as 42,000.", notes: [] }, text);
  }
});

test("zero units is no project, and a count beyond the ladder is told the launch limit and to ask in writing", () => {
  assert.equal(describeEstimate("0", "HUBSPOT", "AVAILABLE").kind, "NOTICE");
  assert.match(describeEstimate("0", "HUBSPOT", "AVAILABLE").text, /^Zero units is not a project\./);
  assert.deepEqual(describeEstimate("1,000,001", "CLEAN", "AVAILABLE"), {
    kind: "NOTICE",
    text: "At launch a project holds up to 500,000 billable source units. If yours is larger, ask in writing.",
    notes: [],
  });
});

test("an offered band shows its indicative price for the mode, with the words estimate and reserves nothing", () => {
  assert.deepEqual(describeEstimate("42,000", "CLEAN", "AVAILABLE"), {
    kind: "RESULT",
    text: "Indicative band: Up to 50,000 units, USD 695 for CLEAN. This is an estimate and reserves nothing.",
    notes: [],
  });
  assert.equal(describeEstimate("50000", "HUBSPOT", "AVAILABLE").text, "Indicative band: Up to 50,000 units, USD 1,295 for HubSpot. This is an estimate and reserves nothing.");
  assert.equal(describeEstimate("50001", "SALESFORCE", "LIMITED").text, "Indicative band: 50,001 to 150,000 units, USD 2,295 for Salesforce. This is an estimate and reserves nothing.");
  assert.equal(describeEstimate(" 150 001 ", "CLEAN", "AVAILABLE").text, "Indicative band: 150,001 to 500,000 units, USD 1,795 for CLEAN. This is an estimate and reserves nothing.");
  assert.equal(describeEstimate("500,000", "CLEAN", "AVAILABLE").kind, "RESULT");
  for (const units of ["1", "42000", "500000"]) assert.doesNotMatch(describeEstimate(units, "CLEAN", "AVAILABLE").text, /\bquote\b/i, "an estimate never calls itself a quote");
});

test("the band that is not offered at launch has no price at all, and says the launch limit and what to do", () => {
  for (const mode of ["CLEAN", "HUBSPOT", "SALESFORCE"] as const) {
    const view = describeEstimate("500,001", mode, "AVAILABLE");
    assert.deepEqual(view, { kind: "NOTICE", text: "At launch a project holds up to 500,000 billable source units. If yours is larger, ask in writing.", notes: [] }, mode);
    assert.doesNotMatch(view.text, /USD/);
  }
  assert.equal(describeEstimate("1,000,000", "CLEAN", "AVAILABLE").text, "At launch a project holds up to 500,000 billable source units. If yours is larger, ask in writing.");
});

test("a mode that is not available, or whose availability cannot be read, is said so beside the estimate, never instead of it", () => {
  const closed = describeEstimate("42,000", "SALESFORCE", "CLOSED");
  assert.equal(closed.kind, "RESULT");
  assert.match(closed.text, /USD 1,495 for Salesforce/);
  assert.deepEqual(closed.notes, ["Salesforce is not available for purchase right now."]);
  const unread = describeEstimate("42,000", "HUBSPOT", "UNREAD");
  assert.deepEqual(unread.notes, ["Whether HubSpot is available cannot be read right now."]);
  assert.deepEqual(describeEstimate("500,001", "CLEAN", "CLOSED").notes, ["CLEAN is not available for purchase right now."], "a closed mode is said so for an unoffered band as well");
  assert.deepEqual(describeEstimate("42,000", "CLEAN", "AVAILABLE").notes, []);
  assert.deepEqual(describeEstimate("42,000", "CLEAN", "LIMITED").notes, []);
  assert.deepEqual(describeEstimate("", "CLEAN", "CLOSED").notes, [], "nothing to add to a prompt");
});
