import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog, ConfirmDialogView, canApprove } from "../src/index.js";
import type { ConfirmDialogCopy, ConfirmDialogError, ConfirmEffect } from "../src/index.js";
import { cancelFromEscape, enterDialog, focusFieldById, suppressEnter } from "../src/internal/dialog-controller.js";
import { accessibleName, byId, elementsOf, findAll, findOne, idsOf, render, textOf, tokensOf } from "./support/markup.js";
import type { ElementNode } from "./support/markup.js";

const copy: ConfirmDialogCopy = {
  approve: "Approve clear",
  cancel: "Cancel",
  errorSummaryTitle: "This confirmation could not be approved",
};

const effects: readonly ConfirmEffect[] = [
  {
    id: "clear-contacts",
    description: "The Contacts column is cleared from every sealed row.",
    count: 1200,
    countLabel: "rows change",
    acknowledgeLabel: "I understand that 1,200 rows are cleared",
  },
  {
    id: "merge-companies",
    description: "Companies with the same domain are merged into one.",
    count: "310",
    countLabel: "companies are merged",
    acknowledgeLabel: "I understand that 310 companies are merged",
  },
];

const noop = (): void => undefined;
const base = { title: "Clear the Contacts column", summary: "Clearing cannot be undone once the delivery is prepared.", effects, copy, onApprove: noop, onCancel: noop };

const refusal: readonly ConfirmDialogError[] = [{ effectId: "clear-contacts", message: "The plan changed; review the count of cleared rows again." }];

const buttons = (root: ElementNode): ElementNode[] => findAll(root, "button");
const buttonNamed = (root: ElementNode, name: string): ElementNode => {
  const found = buttons(root).filter((b) => textOf(b).trim() === name);
  assert.equal(found.length, 1, `exactly one button named ${name}`);
  return found[0] as ElementNode;
};

test("R2-062: the confirmation dialog has no default action — no form, every button type=button, initial focus on the heading, approve disabled until each disclosed effect is acknowledged, and each effect's error referenced by that effect's control", () => {
  const { root, html } = render(createElement(ConfirmDialog, { ...base, open: true, errors: refusal }));
  const dialog = findOne(root, "dialog");

  // No default action: nothing can submit, nothing is focused by the browser on its own.
  assert.equal(findAll(root, "form").length, 0, "no <form> anywhere in the dialog");
  assert.doesNotMatch(html, /type="(?:submit|image|reset)"/);
  for (const element of elementsOf(root)) {
    assert.equal(element.attrs.has("autofocus"), false, `<${element.tag}> must not autofocus; focus is placed on the heading explicitly`);
    assert.equal(element.attrs.has("accesskey"), false);
    assert.equal(element.attrs.has("formaction"), false);
    assert.equal(element.attrs.has("form"), false);
  }
  assert.equal(buttons(root).length, 2, "Cancel and Approve are the only buttons");
  for (const button of buttons(root)) assert.equal(button.attrs.get("type"), "button", `button ${JSON.stringify(textOf(button))}`);

  // Initial focus goes to the heading: it names the dialog, is the first thing in it, and can take programmatic focus.
  const heading = findOne(root, "h2");
  assert.equal(dialog.attrs.get("aria-labelledby"), heading.attrs.get("id"));
  assert.equal(textOf(heading), base.title);
  assert.equal(heading.attrs.get("tabindex"), "-1");
  assert.equal(dialog.children.find((c) => c.kind === "element"), heading, "the heading is the first element of the dialog");
  assert.ok(tokensOf(dialog, "aria-describedby").length >= 1);
  assert.match(textOf(byId(root, tokensOf(dialog, "aria-describedby")[0] as string)), /cannot be undone/);
  const log: string[] = [];
  const stubDialog = { open: false, showModal() { this.open = true; log.push("showModal"); }, close() { this.open = false; log.push("close"); } };
  enterDialog({ dialog: stubDialog, heading: { focus: () => log.push("heading.focus") }, invoker: null });
  assert.deepEqual(log, ["showModal", "heading.focus"], "the dialog opens modally and focus lands on the heading, not on a button");

  // Approve is disabled until every disclosed effect has its own acknowledgement; Cancel is a different, always-available control.
  const approve = buttonNamed(root, copy.approve);
  const cancel = buttonNamed(root, copy.cancel);
  assert.equal(approve.attrs.has("disabled"), true, "nothing acknowledged: approve is disabled");
  assert.equal(cancel.attrs.has("disabled"), false);
  assert.notEqual(approve.attrs.get("class"), cancel.attrs.get("class"), "Cancel does not look like approval");
  const boxes = findAll(root, "input");
  assert.equal(boxes.length, effects.length, "one acknowledgement per disclosed effect");
  for (const [i, box] of boxes.entries()) {
    const effect = effects[i] as ConfirmEffect;
    assert.equal(box.attrs.get("type"), "checkbox");
    assert.equal(box.attrs.has("checked"), false);
    assert.equal(accessibleName(root, box), effect.acknowledgeLabel);
  }
  const view = (acknowledged: ReadonlySet<string>) => render(createElement(ConfirmDialogView, { ...base, acknowledged, onToggle: noop }));
  assert.equal(buttonNamed(view(new Set()).root, copy.approve).attrs.has("disabled"), true);
  assert.equal(buttonNamed(view(new Set(["clear-contacts"])).root, copy.approve).attrs.has("disabled"), true, "one of two acknowledged: still disabled");
  assert.equal(buttonNamed(view(new Set(["merge-companies", "unrelated"])).root, copy.approve).attrs.has("disabled"), true, "an unrelated id acknowledges nothing");
  const all = view(new Set(["clear-contacts", "merge-companies"])).root;
  assert.equal(buttonNamed(all, copy.approve).attrs.has("disabled"), false, "every effect acknowledged: approve is enabled");
  assert.deepEqual(findAll(all, "input").map((b) => b.attrs.has("checked")), [true, true]);
  assert.equal(canApprove(effects, new Set(["clear-contacts", "merge-companies"])), true);
  assert.equal(canApprove(effects, new Set(["clear-contacts"])), false);
  assert.equal(canApprove(effects, new Set(["clear-contacts", "other"])), false);
  assert.equal(canApprove([], new Set()), false, "a confirmation with nothing disclosed can never be approved");
  assert.equal(buttonNamed(render(createElement(ConfirmDialogView, { ...base, acknowledged: new Set(["clear-contacts", "merge-companies"]), pending: true, onToggle: noop })).root, copy.approve).attrs.has("disabled"), true, "an approval in flight cannot be repeated");

  // Each effect's error is referenced by that effect's control, and only by it.
  const [clearBox, mergeBox] = boxes as [ElementNode, ElementNode];
  const clearRefs = tokensOf(clearBox, "aria-describedby");
  const mergeRefs = tokensOf(mergeBox, "aria-describedby");
  assert.equal(clearRefs.length, 2, "description and error");
  assert.equal(mergeRefs.length, 1, "description only");
  const error = byId(root, clearRefs[1] as string);
  assert.equal(textOf(error).trim(), (refusal[0] as ConfirmDialogError).message);
  assert.equal(clearBox.attrs.get("aria-invalid"), "true");
  assert.equal(mergeBox.attrs.has("aria-invalid"), false);
  assert.match(textOf(byId(root, clearRefs[0] as string)), /Contacts column is cleared.*1,200.*rows change/s);
  assert.match(textOf(byId(root, mergeRefs[0] as string)), /same domain.*310.*companies are merged/s);
  assert.equal(new Set(idsOf(root)).size, idsOf(root).length, "every id is unique");

  // The summary lists the refusal and links to that effect's control.
  const summary = findAll(root, "a").filter((a) => textOf(a).trim() === (refusal[0] as ConfirmDialogError).message);
  assert.equal(summary.length, 1);
  assert.equal(summary[0]?.attrs.get("href"), `#${clearBox.attrs.get("id")}`);
  assert.equal(findAll(root, "a").length, 1, "only the refused effect is linked");

  // A refusal that names nothing on screen is still shown — never dropped — and is not attached to any control.
  const stray = render(createElement(ConfirmDialog, { ...base, open: true, errors: [{ effectId: "merge-persons", message: "That effect is not part of this plan." }] }));
  assert.match(textOf(stray.root), /That effect is not part of this plan\./);
  assert.equal(findAll(stray.root, "input").every((b) => b.attrs.get("aria-invalid") === undefined && tokensOf(b, "aria-describedby").length === 1), true);
  assert.equal(findAll(stray.root, "a").length, 0);
});

test("the dialog is not rendered while closed, refuses a confirmation with nothing disclosed, and needs an effect id it can use as a stable DOM id", () => {
  assert.equal(renderToStaticMarkup(createElement(ConfirmDialog, { ...base, open: false })), "");
  const bad = (effectsOverride: readonly ConfirmEffect[]) => () => renderToStaticMarkup(createElement(ConfirmDialog, { ...base, effects: effectsOverride, open: true }));
  assert.throws(bad([]), RangeError);
  assert.throws(bad([{ ...(effects[0] as ConfirmEffect), id: "has space" }]), RangeError);
  assert.throws(bad([effects[0] as ConfirmEffect, effects[0] as ConfirmEffect]), RangeError, "duplicate effect id");
  assert.throws(bad([{ ...(effects[0] as ConfirmEffect), count: -1 }]), RangeError);
  assert.throws(bad([{ ...(effects[0] as ConfirmEffect), count: 1.5 }]), RangeError);
});

test("keyboard behaviour: the dialog returns focus to the invoker, Escape cancels instead of approving, and Enter on a checkbox does nothing", () => {
  const log: string[] = [];
  const stubDialog = { open: false, showModal() { this.open = true; log.push("showModal"); }, close() { this.open = false; log.push("close"); } };
  const heading = { focus: () => log.push("heading.focus") };
  const invoker = { isConnected: true, focus: () => log.push("invoker.focus") };
  const leave = enterDialog({ dialog: stubDialog, heading, invoker });
  leave();
  assert.deepEqual(log, ["showModal", "heading.focus", "close", "invoker.focus"]);
  leave();
  assert.equal(log.length, 4, "leaving twice does nothing more");

  const reopened = { open: true, showModal: () => log.push("showModal-again"), close: () => log.push("close-2") };
  enterDialog({ dialog: reopened, heading, invoker: { isConnected: false, focus: () => log.push("gone.focus") } })();
  assert.deepEqual(log.slice(4), ["heading.focus", "close-2"], "an open dialog is not opened twice and a removed invoker is not focused");

  let cancelled = 0;
  let prevented = 0;
  cancelFromEscape({ preventDefault: () => (prevented += 1) }, () => (cancelled += 1));
  assert.deepEqual([cancelled, prevented], [1, 1], "Escape asks the owner to cancel and never lets the browser close the dialog by itself");

  const key = (name: string, tagName: string) => ({ key: name, target: { tagName } });
  assert.equal(suppressEnter(key("Enter", "INPUT")), true);
  assert.equal(suppressEnter(key("Enter", "H2")), true);
  assert.equal(suppressEnter(key("Enter", "BUTTON")), false, "Enter on a focused button is that button's own activation");
  assert.equal(suppressEnter(key("Enter", "A")), false, "Enter follows a focused link");
  assert.equal(suppressEnter(key(" ", "INPUT")), false, "Space toggles a checkbox");

  const focused: string[] = [];
  const elements = new Map([["field-1", { focus: () => focused.push("field-1") }]]);
  assert.equal(focusFieldById((id) => elements.get(id) ?? null, "field-1"), true);
  assert.equal(focusFieldById((id) => elements.get(id) ?? null, "missing"), false);
  assert.deepEqual(focused, ["field-1"]);
});

test("an effect that counts nothing (a role that changes, a period that starts) is disclosed and acknowledged without a count", () => {
  const uncounted: readonly ConfirmEffect[] = [{ id: "wait", description: "A waiting period starts.", acknowledgeLabel: "I understand a waiting period applies" }];
  const markup = renderToStaticMarkup(createElement(ConfirmDialogView, { ...base, effects: uncounted, acknowledged: new Set<string>(), onToggle: noop }));
  assert.match(markup, /A waiting period starts\./);
  assert.match(markup, /I understand a waiting period applies/);
  assert.doesNotMatch(markup, /undefined/);
});
