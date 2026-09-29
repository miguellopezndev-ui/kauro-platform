import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import { Button, ErrorSummary, Field, FieldError, Hint, Label, LinkButton, isSafeHref } from "../src/index.js";
import type { ControlProps } from "../src/index.js";
import { accessibleName, byId, findAll, findOne, idsOf, render, textOf, tokensOf } from "./support/markup.js";

const input = (control: ControlProps): ReactElement => createElement("input", { ...control, type: "text", name: "company" });

test("D-A11Y-1: a field's control is named by its label and described by its hint, then its error, through aria-describedby, and is aria-invalid only when there is an error", () => {
  const { root } = render(createElement(Field, { id: "company", label: "Company name", hint: "As it appears on the invoice", error: "Enter the company name", children: input }));
  const control = findOne(root, "input");
  assert.equal(control.attrs.get("id"), "company");
  assert.equal(accessibleName(root, control), "Company name");
  assert.deepEqual(tokensOf(control, "aria-describedby"), ["company-hint", "company-error"]);
  assert.equal(control.attrs.get("aria-invalid"), "true");
  assert.equal(textOf(byId(root, "company-hint")), "As it appears on the invoice");
  assert.equal(textOf(byId(root, "company-error")), "Enter the company name");
  assert.equal(findAll(root, "svg").length, 1, "the error carries an icon, so it is not signalled by colour alone");
  assert.equal(findOne(root, "svg").attrs.get("aria-hidden"), "true");
  assert.equal(new Set(idsOf(root)).size, idsOf(root).length);
});

test("D-A11Y-1: a field with no hint and no error has neither element nor attribute, and only a hint or only an error is described alone", () => {
  const plain = render(createElement(Field, { id: "company", label: "Company name", children: input })).root;
  const control = findOne(plain, "input");
  assert.equal(control.attrs.has("aria-describedby"), false);
  assert.equal(control.attrs.has("aria-invalid"), false);
  assert.equal(findAll(plain, "p").length, 0);
  assert.equal(accessibleName(plain, control), "Company name");
  const hinted = render(createElement(Field, { id: "company", label: "Company name", hint: "Legal name", children: input })).root;
  assert.deepEqual(tokensOf(findOne(hinted, "input"), "aria-describedby"), ["company-hint"]);
  assert.equal(findOne(hinted, "input").attrs.has("aria-invalid"), false);
  const failed = render(createElement(Field, { id: "company", label: "Company name", error: "Required", children: input })).root;
  assert.deepEqual(tokensOf(findOne(failed, "input"), "aria-describedby"), ["company-error"]);
  assert.equal(findOne(failed, "input").attrs.get("aria-invalid"), "true");
});

test("D-A11Y-1: a field's text is text: markup in a label, hint or error is escaped and a control id that could break the association is refused", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const { root, html } = render(createElement(Field, { id: "company", label: hostile, hint: hostile, error: hostile, children: input }));
  assert.equal(findAll(root, "img").length, 0);
  assert.doesNotMatch(html, /<img/);
  assert.equal(textOf(byId(root, "company-error")), hostile);
  for (const bad of ["", "has space", "1abc", "a#b", 'a"b']) assert.throws(() => render(createElement(Field, { id: bad, label: "x", children: input })), RangeError, JSON.stringify(bad));
});

test("D-DS-1: Label, Hint and FieldError are the parts a page composes by hand — a label bound by for, and a hint and an error carrying the id a control refers to", () => {
  const { root } = render(
    createElement("div", null, createElement(Label, { htmlFor: "a", children: "Name" }), createElement("input", { id: "a", "aria-describedby": "a-hint a-error" }), createElement(Hint, { id: "a-hint", children: "Help" }), createElement(FieldError, { id: "a-error", children: "Wrong" })),
  );
  assert.equal(accessibleName(root, findOne(root, "input")), "Name");
  assert.equal(textOf(byId(root, "a-hint")), "Help");
  assert.equal(textOf(byId(root, "a-error")), "Wrong");
});

test("D-A11Y-1: the error summary is a named group whose heading names it, whose items link to the control each error belongs to and whose focus target is the group itself", () => {
  const { root } = render(
    createElement(ErrorSummary, {
      title: "There is a problem",
      errors: [
        { fieldId: "company", message: "Enter the company name" },
        { fieldId: "contact", message: "Enter a valid email address" },
        { fieldId: null, message: "The file could not be read" },
      ],
    }),
  );
  const group = findOne(root, "div", "summary group");
  assert.equal(group.attrs.get("role"), "group");
  assert.equal(group.attrs.get("tabindex"), "-1", "focus can be moved to the group by script, and it is not a tab stop");
  const heading = findOne(root, "h2");
  assert.deepEqual(tokensOf(group, "aria-labelledby"), [heading.attrs.get("id")]);
  assert.equal(textOf(heading), "There is a problem");
  assert.equal(group.attrs.has("aria-live"), false, "focus announces the summary, so it is not also a live region");
  assert.notEqual(group.attrs.get("role"), "alert");
  assert.deepEqual(
    findAll(root, "a").map((a) => [a.attrs.get("href"), textOf(a)]),
    [
      ["#company", "Enter the company name"],
      ["#contact", "Enter a valid email address"],
    ],
  );
  assert.deepEqual(findAll(root, "li").map((li) => textOf(li)), ["Enter the company name", "Enter a valid email address", "The file could not be read"]);
});

test("D-A11Y-1: an empty error summary renders nothing, and it sits under the heading level its page has", () => {
  assert.equal(render(createElement(ErrorSummary, { title: "There is a problem", errors: [] })).html, "");
  const nested = render(createElement(ErrorSummary, { title: "Problem", errors: [{ fieldId: "a", message: "m" }], headingLevel: 3 })).root;
  assert.equal(findAll(nested, "h3").length, 1);
  assert.equal(findAll(nested, "h2").length, 0);
});

test("D-DS-1: a Button is type=button unless the caller says submit, always carries the button classes and cannot be given a class or an inline style", () => {
  const plain = findOne(render(createElement(Button, null, "Cancel")).root, "button");
  assert.equal(plain.attrs.get("type"), "button");
  assert.equal(plain.attrs.get("class"), "kauro-button kauro-button-secondary");
  assert.equal(findOne(render(createElement(Button, { variant: "primary", type: "submit" }, "Save")).root, "button").attrs.get("type"), "submit");
  assert.equal(findOne(render(createElement(Button, { variant: "danger" }, "Remove")).root, "button").attrs.get("class"), "kauro-button kauro-button-danger");
  assert.equal(findOne(render(createElement(Button, { disabled: true }, "Approve")).root, "button").attrs.has("disabled"), true);
  // Whatever a caller (or a spread of unchecked props) passes, the class is the design system's and there is no style attribute.
  const smuggled = { className: "evil", style: { color: "red" }, dangerouslySetInnerHTML: { __html: "<b>x</b>" } } as unknown as Record<string, never>;
  const forced = render(createElement(Button, smuggled as never)).root;
  const attrs = findOne(forced, "button").attrs;
  assert.equal(attrs.get("class"), "kauro-button kauro-button-secondary");
  assert.equal(attrs.has("style"), false);
  assert.equal(findAll(forced, "b").length, 0);
});

test("D-DS-1: a LinkButton is a link that looks like a button and refuses an address that would run script or carry a document", () => {
  const link = findOne(render(createElement(LinkButton, { href: "/clients?cursor=abc" }, "Next")).root, "a");
  assert.equal(link.attrs.get("href"), "/clients?cursor=abc");
  assert.equal(link.attrs.get("class"), "kauro-button kauro-button-secondary");
  for (const safe of ["/a", "?page=2", "#top", "https://example.com/x", "mailto:a@example.com", "relative/path"]) assert.equal(isSafeHref(safe), true, safe);
  for (const unsafe of ["javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "\u0001javascript:x"]) {
    assert.equal(isSafeHref(unsafe), false, JSON.stringify(unsafe));
    assert.throws(() => render(createElement(LinkButton, { href: unsafe }, "x")), RangeError, JSON.stringify(unsafe));
  }
});
