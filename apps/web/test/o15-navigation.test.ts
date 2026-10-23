// Order 15 §4, the navigation layer of the owner's scenario (a seller opens Commissions). The web is presentation, never authorization (08
// "Identity is not permission"; the api refuses every owner read and action to a seller: apps/api/test/o15-seller-owner.test.ts and
// o15-access-matrix.test.ts). What the navigation itself must hold: the owner's menu (the production default) never lists the seller's own
// Commissions entry; a seller's narrowed menu holds only the seller's screens — Commissions among them, on its own route — and never an owner
// screen; and every one of those routes is served only on the operations host, never on the agency application's or the public one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OPS_NAVIGATION, SCREENS, matchRoute, opsNavigationFor } from "../src/screens.ts";
import type { HostConfig } from "../src/server/host-config.ts";
import { decideRoute } from "../src/server/host-routing.ts";

/** Every operations screen and proposal, as if every page of the private origin were built (the review draws them all). */
const EVERY_OPS = new Set<string>([...SCREENS.filter((s) => s.origin === "OPS").map((s) => s.id), ...OPS_NAVIGATION.map((e) => e.screen)]);
/** The seller's screens (seller-portal.md §12.1): Today, Prospects, Outreach, Commissions and Resources. */
const SELLER = new Set(["UI33", "UI34", "UI54", "UI36", "UI53"]);
/** The owner's own screens: money, sellers, customers, claims, operations and company. */
const OWNER_ONLY = new Set(["UI35", "UI37", "UI38", "UI39", "UI40", "UI41", "UI42", "UI43", "UI44", "UI55", "P-04", "P-21", "P-22", "P-23", "P-24"]);
const COMMISSIONS = "/ops/sales/statements";

const SPLIT: HostConfig = { ok: true, policy: { kind: "SPLIT", publicHost: "www.kauro.example", appHost: "app.kauro.example", opsHost: "ops.kauro.example" } };

test("O15 §4 navigation: the owner's menu never lists the seller's Commissions entry, even with every page built", () => {
  const owners = opsNavigationFor(EVERY_OPS);
  assert.ok(!owners.some((entry) => entry.screen === "UI36" || entry.href === COMMISSIONS), "no Commissions entry in the owner's menu");
  assert.ok(owners.some((entry) => entry.screen === "UI39"), "the owner's menu is the owner's (Finance)");
});

test("O15 §4 navigation: a seller's menu holds only the seller's screens — Commissions on its own route — and never an owner screen", () => {
  const sellers = opsNavigationFor(EVERY_OPS, SELLER);
  assert.deepEqual(new Set(sellers.map((entry) => entry.screen)), SELLER, "exactly the seller's five entries");
  for (const entry of sellers) assert.ok(!OWNER_ONLY.has(entry.screen), `${entry.screen} is an owner screen`);
  const commissions = sellers.find((entry) => entry.screen === "UI36");
  assert.equal(commissions?.href, COMMISSIONS);
  assert.equal(matchRoute(COMMISSIONS)?.screen.id, "UI36", "the link opens the seller's statements screen, nothing else");
});

test("O15 §4 navigation: every operations route — the seller's included — is served only on the operations host", () => {
  for (const screen of SCREENS.filter((s) => s.origin === "OPS")) {
    const path = screen.route.replace(/\{([A-Za-z]+)\}/g, "abc123");
    assert.equal(decideRoute(SPLIT, "ops.kauro.example", path), "PASS", `${screen.id} on the operations host`);
    assert.equal(decideRoute(SPLIT, "app.kauro.example", path), "NOT_FOUND", `${screen.id} is not served on the application host`);
    assert.equal(decideRoute(SPLIT, "www.kauro.example", path), "NOT_FOUND", `${screen.id} is not served on the public host`);
  }
});
