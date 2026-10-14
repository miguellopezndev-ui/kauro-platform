// UI01-UI08, UI48 and UI49: the public pages, rendered to static markup and read the way a visitor, a screen reader and an auditor read them.
// The markup is produced by the same components the routes render; only the publication and the sign-in address are handed in.
//
// What is held here, page by page and across all of them:
//   - each page has one h1 and it is the registry's primary copy for the screen; headings never skip a level; ids are unique and every
//     reference (labelledby, describedby, label for, fragment link) has its target;
//   - a link goes only to a route of the public site, a fragment, or the sign-in address; nothing loads a script, a frame, an image or an
//     inline style, and every table has a caption and header scopes (D-A11Y-1, D-SEC-1);
//   - the A3 lint holds over the rendered text: AI appears in one sentence on Home and nowhere else, no fifteen-minute promise, no founding
//     line, no savings amount, and every dollar figure is a band price of the policy;
//   - availability comes from the publication and from nothing else: a service the publication does not list is never described as open,
//     and a publication that cannot be read makes no statement about any service;
//   - the unsubscribe page changes nothing and never reads the token.
// The publication is a value built with parsePublication from the api's published shape (CONTRACT_FAKE: no api is involved).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { R2_DOMAIN_ALIASES } from "@kauro/contracts";
import { PUBLIC_COPY } from "../src/copy/public.ts";
import { HEALTH_CHECK_CTA, PERMITTED_AI_SENTENCE, lintText } from "../src/copy/lint.ts";
import { parsePublication, UNAVAILABLE, type Publication } from "../src/public/capabilities.ts";
import { DESTINATIONS, RECORD_BANDS, TIMINGS } from "../src/public/inquiry.ts";
import { HelpPage } from "../src/public/pages/help.tsx";
import { HomePage } from "../src/public/pages/home.tsx";
import { HowItWorksPage } from "../src/public/pages/how-it-works.tsx";
import { PricingPage } from "../src/public/pages/pricing.tsx";
import { SampleDeliveryPage } from "../src/public/pages/sample-delivery.tsx";
import { SecurityPage } from "../src/public/pages/security.tsx";
import { StatusPage } from "../src/public/pages/status.tsx";
import { SupportedServicesPage } from "../src/public/pages/supported-services.tsx";
import { ContactPage } from "../src/public/pages/contact.tsx";
import { UnsubscribePage } from "../src/public/pages/unsubscribe.tsx";
import { NavList, SiteFrame } from "../src/public/frame.tsx";
import { BANDS, formatUsd } from "../src/public/pricing-bands.ts";
import { RETENTION_ROWS } from "../src/public/retention.ts";
import { FOOTER_NAV, MAIN_NAV, ROUTE, SITE_PAGES, type PageKey } from "../src/public/site.ts";
import { registryScreens } from "./support/registry.ts";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const brands = [...new Set(Object.keys(R2_DOMAIN_ALIASES).map((name) => name.split("_")[0] ?? ""))].filter((name) => name.length > 0);
const SIGN_IN = "https://app.kauro.example/login";

const ID = "0192d3a4-5b6c-7d8e-9f01-23456789abcd";
const entry = (mode: string, state = "AVAILABLE"): Record<string, unknown> => ({ capabilityId: ID, mode, version: "2026.10.0", state, validFrom: "2026-10-01T15:00:00.000Z" });
const publication = (...capabilities: Record<string, unknown>[]): Publication => parsePublication({ observedAt: "2026-10-02T09:30:45.123Z", capabilities });
const ALL = publication(entry("CLEAN"), entry("HUBSPOT"), entry("SALESFORCE"));
const CLEAN_ONLY = publication(entry("CLEAN"));
const NOTHING = publication();

// ---- reading markup -------------------------------------------------------------------------------------------------------------------

const decode = (value: string): string => value.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const textOf = (html: string): string => decode(html.replaceAll(/<[^>]*>/g, " ")).replaceAll(/\s+/g, " ").trim();
const render = (element: ReactElement): string => renderToStaticMarkup(element);
const headings = (html: string): Array<{ level: number; text: string }> => [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((match) => ({ level: Number(match[1]), text: textOf(match[2] ?? "") }));
const idsOf = (html: string): string[] => [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1] ?? "");
const hrefsOf = (html: string): string[] => [...html.matchAll(/\shref="([^"]*)"/g)].map((match) => decode(match[1] ?? ""));
const linkTexts = (html: string): Array<{ href: string; text: string; cls: string }> =>
  [...html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({ href: decode(/href="([^"]*)"/.exec(match[1] ?? "")?.[1] ?? ""), text: textOf(match[2] ?? ""), cls: /class="([^"]*)"/.exec(match[1] ?? "")?.[1] ?? "" }));
const count = (text: string, needle: string): number => text.split(needle).length - 1;

interface PageCase {
  readonly key: PageKey;
  readonly screen: string;
  readonly html: (read: Publication) => string;
}

const PAGES: readonly PageCase[] = [
  { key: "home", screen: "UI01", html: (read) => render(createElement(HomePage, { publication: read, signInHref: SIGN_IN })) },
  { key: "how", screen: "UI02", html: () => render(createElement(HowItWorksPage)) },
  { key: "services", screen: "UI03", html: (read) => render(createElement(SupportedServicesPage, { publication: read })) },
  { key: "pricing", screen: "UI04", html: (read) => render(createElement(PricingPage, { publication: read, signInHref: SIGN_IN })) },
  { key: "sample", screen: "UI05", html: () => render(createElement(SampleDeliveryPage)) },
  { key: "security", screen: "UI06", html: () => render(createElement(SecurityPage)) },
  { key: "contact", screen: "UI07", html: () => render(createElement(ContactPage)) },
  { key: "status", screen: "UI08", html: (read) => render(createElement(StatusPage, { publication: read })) },
  { key: "help", screen: "UI48", html: () => render(createElement(HelpPage)) },
  { key: "unsubscribe", screen: "UI49", html: () => render(createElement(UnsubscribePage)) },
];
const page = (key: PageKey): PageCase => {
  const found = PAGES.find((candidate) => candidate.key === key);
  assert.ok(found !== undefined, key);
  return found;
};
const READINGS: ReadonlyArray<readonly [string, Publication]> = [["all modes", ALL], ["clean only", CLEAN_ONLY], ["none listed", NOTHING], ["unreadable", UNAVAILABLE]];

// ---- structure, on every page and every reading ---------------------------------------------------------------------------------------

test("each page has one h1, it is the screen's primary copy from the registry, and the headings never skip a level", () => {
  const registry = registryScreens();
  assert.equal(PAGES.length, SITE_PAGES.length);
  for (const { key, screen, html } of PAGES) {
    for (const [name, read] of READINGS) {
      const list = headings(html(read));
      assert.equal(list.filter((heading) => heading.level === 1).length, 1, `${key} (${name}): one h1`);
      assert.equal(list[0]?.level, 1, `${key} (${name}): the h1 comes first`);
      assert.equal(list[0]?.text, registry.get(screen)?.primaryCopy, `${key} (${name}): the h1 is the registry's primary copy`);
      let previous = 1;
      for (const heading of list.slice(1)) {
        assert.ok(heading.level >= 2 && heading.level <= previous + 1, `${key} (${name}): "${heading.text}" jumps from h${previous} to h${heading.level}`);
        previous = heading.level;
      }
    }
  }
});

test("ids are unique and every reference has its target: labelledby, describedby, label for and fragment links", () => {
  for (const { key, html } of PAGES) {
    for (const [name, read] of READINGS) {
      const markup = html(read);
      const ids = idsOf(markup);
      assert.equal(new Set(ids).size, ids.length, `${key} (${name}): duplicate id in ${ids.join(", ")}`);
      const known = new Set(ids);
      for (const match of markup.matchAll(/\saria-(?:labelledby|describedby|controls)="([^"]*)"/g)) for (const target of (match[1] ?? "").split(/\s+/).filter((value) => value.length > 0)) assert.ok(known.has(target), `${key} (${name}): aria reference to missing id ${target}`);
      for (const match of markup.matchAll(/<label[^>]*\sfor="([^"]*)"/g)) assert.ok(known.has(match[1] ?? ""), `${key} (${name}): label for missing id ${match[1]}`);
      for (const href of hrefsOf(markup).filter((value) => value.startsWith("#"))) assert.ok(known.has(href.slice(1)), `${key} (${name}): fragment ${href} has no target`);
      for (const match of markup.matchAll(/<section[^>]*>/g)) assert.match(match[0], /aria-labelledby="/, `${key} (${name}): a section is named by its heading`);
    }
  }
});

test("a link goes only to a route of the public site, a fragment, or the sign-in address, and nothing opens a new context", () => {
  const routes = new Set<string>([...Object.values(ROUTE), SIGN_IN]);
  for (const { key, html } of PAGES) {
    for (const [name, read] of READINGS) {
      const markup = html(read);
      for (const href of hrefsOf(markup)) assert.ok(href.startsWith("#") || routes.has(href), `${key} (${name}): unexpected link ${href}`);
      assert.doesNotMatch(markup, /\starget=/, `${key} (${name}): no link opens another context`);
      assert.doesNotMatch(markup, /\srel="[^"]*noopener/, `${key} (${name}): nothing to open`);
      for (const link of linkTexts(markup)) assert.ok(link.text.length > 0, `${key} (${name}): a link with no text (${link.href})`);
    }
  }
});

test("no page loads a script, a frame, an image, a stylesheet or an inline style, and none carries an event handler attribute", () => {
  for (const { key, html } of PAGES) {
    for (const [name, read] of READINGS) {
      const markup = html(read);
      for (const pattern of [/<script/i, /<iframe/i, /<img/i, /<svg/i, /<link/i, /<object/i, /<embed/i, /<video/i, /<audio/i, /\sstyle=/i, /\son[a-z]+=/i, /javascript:/i, /dangerously/i]) assert.doesNotMatch(markup, pattern, `${key} (${name}): ${pattern}`);
    }
  }
});

test("every table has a caption first and a scope on every header cell, and every list item is inside a list", () => {
  for (const { key, html } of PAGES) {
    const markup = html(ALL);
    for (const table of markup.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
      assert.match(table[1] ?? "", /^<caption>[^<]+<\/caption>/, `${key}: a table starts with its caption`);
      for (const header of (table[1] ?? "").matchAll(/<th(\s[^>]*)?>/g)) assert.match(header[1] ?? "", /\sscope="(col|row)"/, `${key}: a header cell names what it heads`);
    }
    assert.equal(count(markup, "<table"), count(markup, "</table>"));
    for (const item of markup.matchAll(/<li[\s>]/g)) assert.ok(item.index !== undefined && /<(ul|ol)[\s>]/.test(markup.slice(0, item.index)), `${key}: <li> outside a list`);
  }
});

// ---- the A3 lint over what a visitor reads --------------------------------------------------------------------------------------------

test("the text each page renders passes the A3 lint under every reading, and AI appears in one sentence on Home and on no other page", () => {
  for (const { key, html } of PAGES) {
    for (const [name, read] of READINGS) {
      const text = textOf(html(read));
      assert.deepEqual(lintText(`${key} (${name})`, text, { brands }), [], `${key} (${name})`);
      const ai = (text.match(/\bAI\b/g) ?? []).length;
      if (key === "home") {
        assert.equal(ai, 1, `home (${name}): exactly one AI word`);
        assert.equal(count(text, PERMITTED_AI_SENTENCE), 1, `home (${name}): in the permitted sentence`);
      } else assert.equal(ai, 0, `${key} (${name}): no AI word`);
      assert.doesNotMatch(text, /artificial intelligence|machine learning|\bLLMs?\b|chatbot/i, `${key} (${name})`);
      if (key !== "security") assert.doesNotMatch(text, /\b(15|fifteen)[- ]minutes?\b/i, `${key} (${name}): no fifteen-minute promise`);
      assert.doesNotMatch(text, /founding/i, `${key} (${name}): the founding line stays hidden`);
      assert.doesNotMatch(text.replaceAll("does not guarantee", ""), /\b(guarantee[sd]?|100% accurate|zero errors|risk[- ]free|instant(ly)?)\b/i, `${key} (${name}): no guarantee (only a refusal to guarantee is allowed)`);
      assert.doesNotMatch(text, /\b(SOC ?2|ISO ?27001|HIPAA|PCI[- ]DSS)\b|\bcertified\b/i, `${key} (${name}): no certification claim`);
      assert.doesNotMatch(text, /\b(Pipedrive|Zoho|Dynamics|Freshsales|Insightly|SugarCRM|Odoo|Zendesk|Close\.com)\b/i, `${key} (${name}): another CRM is never named`);
    }
  }
});

test("every dollar figure a page states is a band price of the policy, and the band that is not offered has no price on any page", () => {
  const allowed = new Set<string>();
  BANDS.forEach((band, index) => {
    if (index < 3) for (const minor of Object.values(band.minor)) allowed.add(formatUsd(minor));
  });
  const notOffered = Object.values(BANDS[3]?.minor ?? {}).map((minor) => formatUsd(minor));
  assert.equal(notOffered.length, 3);
  for (const { key, html } of PAGES) {
    const text = textOf(html(ALL));
    for (const amount of text.match(/USD [\d,]+(?:\.\d{2})?/g) ?? []) assert.ok(allowed.has(amount), `${key}: ${amount} is not a price of an offered band`);
    for (const amount of notOffered) assert.equal(text.includes(amount), false, `${key}: ${amount} belongs to the band that is not offered`);
    assert.doesNotMatch(text, /[$€£]/, `${key}: money is written USD, never with a symbol`);
  }
});

// ---- Home -----------------------------------------------------------------------------------------------------------------------------

test("Home: the job line, one call to action, the sample and pricing beside it, the synthetic AI sentence below the fold, and the services open now", () => {
  const html = page("home").html(ALL);
  const text = textOf(html);
  assert.equal(headings(html)[0]?.text, "Prepare and verify CRM data from files.");
  assert.equal(PUBLIC_COPY["public.cta.request-health-check.cta"], HEALTH_CHECK_CTA);
  const primary = linkTexts(html).filter((link) => link.cls.includes("kauro-site-button--primary"));
  assert.ok(primary.length >= 1 && primary.length <= 2, "the same call to action at the top and at the end at most");
  assert.deepEqual([...new Set(primary.map((link) => `${link.text}|${link.href}`))], [`${HEALTH_CHECK_CTA}|${SIGN_IN}`], "one call to action, and it leads to sign-in");
  assert.match(text, /The free data health check creates no obligation to buy\./);
  assert.ok(text.indexOf("View the synthetic sample") > 0 && hrefsOf(html).includes(ROUTE.sample) && hrefsOf(html).includes(ROUTE.pricing));
  const ai = text.indexOf(PERMITTED_AI_SENTENCE);
  assert.ok(ai > text.indexOf("What your agency receives") && ai > text.indexOf("What Kauro does not do"), "the AI sentence comes after the offer and the limits");
  assert.ok(text.indexOf(HEALTH_CHECK_CTA) < ai, "the call to action comes before it");
  assert.equal(headings(html).some((heading) => /\bAI\b/.test(heading.text)), false, "no AI in a headline");
  for (const claim of ["never connects to or changes a live CRM", "does not connect to, change or delete records in a live CRM", "prepared for import, and never as imported"]) assert.ok(text.includes(claim), claim);
});

test("Home lists the services the publication lists, and says so plainly when it lists none or cannot be read", () => {
  const modes = (read: Publication): string => textOf((/<section[^>]*aria-labelledby="home-modes-heading"[\s\S]*?<\/section>/.exec(page("home").html(read)) ?? [""])[0]);
  assert.match(modes(ALL), /CLEAN.*HubSpot.*Salesforce/);
  const clean = modes(CLEAN_ONLY);
  assert.match(clean, /CLEAN/);
  assert.doesNotMatch(clean, /HubSpot|Salesforce/, "a service the publication does not list is not named as open");
  assert.match(modes(NOTHING), /No service is open for new projects right now\./);
  assert.doesNotMatch(modes(NOTHING), /CLEAN|HubSpot|Salesforce/);
  assert.match(modes(UNAVAILABLE), /cannot be read right now/);
  assert.doesNotMatch(modes(UNAVAILABLE), /CLEAN|HubSpot|Salesforce/, "an unreadable publication opens nothing");
});

// ---- How it works ---------------------------------------------------------------------------------------------------------------------

test("How it works: six steps in an ordered list, the check bounded and free, approval named, the quote from the server, and the import the agency's own", () => {
  const html = page("how").html(ALL);
  const text = textOf(html);
  assert.equal(count(html, "<ol"), 1);
  assert.equal((/<ol[\s\S]*?<\/ol>/.exec(html)?.[0].match(/<li[\s>]/g) ?? []).length, 6);
  assert.deepEqual(headings(html).filter((heading) => heading.level === 3).map((heading) => heading.text), ["Upload your source files", "Get the free data health check", "Your agency decides", "Review the quote and pay", "Kauro prepares the delivery", "Your team imports"]);
  for (const claim of ["free and creates no obligation to buy", "is bounded", "A duplicate candidate is never treated as a confirmed duplicate", "cannot approve anything", "The server prices the project", "confirmed by the payment provider", "Kauro does not write to your CRM at any step"]) assert.ok(text.includes(claim), claim);
  assert.doesNotMatch(text, /\b(minutes|hours)\b/i, "the check names no duration");
  assert.ok(hrefsOf(html).includes(ROUTE.services));
});

// ---- Supported services ---------------------------------------------------------------------------------------------------------------

function card(html: string, name: string): string {
  const found = [...html.matchAll(/<article[^>]*>[\s\S]*?<\/article>/g)].map((match) => match[0]).find((article) => headings(article)[0]?.text === name);
  assert.ok(found !== undefined, `a card named ${name}`);
  return textOf(found);
}

test("Supported services: CLEAN stands beside HubSpot and Salesforce as one of three peers, each with its state read from the publication", () => {
  const html = page("services").html(ALL);
  const h3 = headings(html).filter((heading) => heading.level === 3).map((heading) => heading.text);
  assert.deepEqual(h3, ["CLEAN", "HubSpot", "Salesforce"]);
  assert.equal(count(html, "<article"), 3);
  for (const name of ["CLEAN", "HubSpot", "Salesforce"]) assert.match(card(html, name), /Available for new projects/);
  assert.match(textOf(html), /Read from the capability publication at 2026-10-02 09:30 UTC\./);
  assert.match(card(html, "HubSpot"), /Publication version 2026\.10\.0, available since 2026-10-01 15:00 UTC\./);
  assert.match(card(html, "CLEAN"), /Kauro qualifies imports only for HubSpot and Salesforce\./);
  assert.match(card(html, "HubSpot"), /marketing-contact status and paid enrichment stay switched off/);
  assert.match(card(html, "Salesforce"), /does not deploy fields, validation rules, automations or external identifier settings/);
  assert.match(card(html, "CLEAN"), /A cleaned file is not a promise about how another CRM will read it\./);
  assert.doesNotMatch(textOf(html), /compatible|works with any/i, "no compatibility claim");
});

test("Supported services: a service the publication does not list is not offered, and CLEAN names as qualified only the destinations it lists", () => {
  const partial = page("services").html(publication(entry("CLEAN"), entry("HUBSPOT", "AVAILABLE_LIMITED")));
  assert.match(card(partial, "HubSpot"), /Available for new projects, within the published limits/);
  assert.match(card(partial, "Salesforce"), /Not available for purchase/);
  assert.doesNotMatch(card(partial, "Salesforce"), /Data Loader|Publication version/, "a closed service is not described as if it were open");
  assert.match(card(partial, "CLEAN"), /Kauro qualifies imports only for HubSpot\./);
  assert.doesNotMatch(card(partial, "CLEAN"), /Salesforce/);
  const clean = page("services").html(CLEAN_ONLY);
  assert.match(card(clean, "CLEAN"), /does not qualify an import for any destination right now/);
  assert.match(card(clean, "HubSpot"), /Not available for purchase/);
  const none = page("services").html(NOTHING);
  for (const name of ["CLEAN", "HubSpot", "Salesforce"]) assert.match(card(none, name), /Not available for purchase/);
  assert.match(textOf(none), /lists no service as available for new projects right now/);
  assert.match(textOf(none), /There is nothing to buy right now\./);
});

test("Supported services: a publication that cannot be read shows no service as available and says neither running nor stopped", () => {
  const html = page("services").html(UNAVAILABLE);
  const text = textOf(html);
  assert.match(text, /The capability publication cannot be read right now, so no service is shown as available\./);
  for (const name of ["CLEAN", "HubSpot", "Salesforce"]) {
    assert.match(card(html, name), /Availability cannot be read right now/);
    assert.doesNotMatch(card(html, name), /Available for new projects|Publication version/);
  }
  assert.match(card(html, "CLEAN"), /Which imports Kauro qualifies is shown here when the capability publication can be read\./);
  assert.doesNotMatch(card(html, "CLEAN"), /HubSpot|Salesforce/);
  assert.doesNotMatch(text, /Read from the capability publication at/, "no observation time is invented");
});

test("Supported services: the scope, the exclusions and the limits of a project, with the limits taken from the policy", () => {
  const text = textOf(page("services").html(ALL));
  for (const claim of ["contacts, organisations or accounts, and deals or opportunities", "Lead conversion, custom objects, activities, attachments, engagement history, campaign memberships, owner setup and automations are not included", "CSV and spreadsheet (XLSX) files", "Up to 50 files in one set, and up to 2 GB for each file", "Up to 5 GB for the whole set of files, and up to 800 columns in a table", "Up to 500,000 billable source units in one project at launch", "ask in writing"]) assert.ok(text.includes(claim), claim);
  assert.ok(hrefsOf(page("services").html(ALL)).includes(ROUTE.contact));
});

// ---- Pricing --------------------------------------------------------------------------------------------------------------------------

test("Pricing: the ladder is the policy's bands, with the first three bands priced and the fourth marked not offered and unpriced", () => {
  const html = page("pricing").html(ALL);
  const table = /<table[\s\S]*?<\/table>/.exec(html)?.[0] ?? "";
  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => [...(match[1] ?? "").matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => textOf(cell[1] ?? "")));
  assert.deepEqual(rows, [
    ["Billable source units", "CLEAN", "HubSpot", "Salesforce"],
    ["Up to 50,000", "USD 695", "USD 1,295", "USD 1,495"],
    ["50,001 to 150,000", "USD 1,095", "USD 1,995", "USD 2,295"],
    ["150,001 to 500,000", "USD 1,795", "USD 2,995", "USD 3,495"],
    ["500,001 to 1,000,000", "Not offered yet", "Not offered yet", "Not offered yet"],
  ]);
  assert.match(textOf(html), /Prices are in US dollars and before tax\. A band that is not offered yet carries no price\./);
});

test("Pricing: every price is an indicative band until the server quotes, tax is on the quote, and the free check obliges nothing", () => {
  const text = textOf(page("pricing").html(ALL));
  for (const claim of [
    "Every price on this page is an indicative band. The price you pay is the quote Kauro issues from the exact count in your sealed files, and an estimate reserves nothing.",
    "An estimate on this page is not a quote. A binding quote is issued from your sealed files, stays valid for 14 days, and shows the band, any discount, taxes, the total and the currency.",
    "Prices are before tax. Any tax that applies is shown on your quote before you pay.",
    "Free. It measures your files before you decide, and creates no obligation to buy.",
    "From USD 695 for up to 50,000 billable source units.",
    "From USD 1,295 for up to 50,000 billable source units.",
    "From USD 1,495 for up to 50,000 billable source units.",
    "5%, 10% and 15% off a new quote for a customer that has bought before.",
    "The unit is a billable source unit",
    "counted before any duplicates are unified",
    "Splitting a file into several files does not lower the count",
  ]) assert.ok(text.includes(claim), claim);
  assert.doesNotMatch(text, /\b(save|saving|savings|discount of|% off your project)\b/i, "no savings claim, only the repeat discount on a new quote");
});

test("Pricing: the company sentence says a company buys at the same prices and discounts, and the repeat discounts are the policy's tiers over its lookback window", () => {
  const html = page("pricing").html(ALL);
  const text = textOf(html);
  assert.equal(count(text, "Companies preparing their own CRM data can buy Kauro directly, at the same prices and discounts as agencies."), 1);
  const table = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((match) => match[0])[1] ?? "";
  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => [...(match[1] ?? "").matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => textOf(cell[1] ?? "")));
  assert.deepEqual(rows, [["Qualifying projects", "Discount on the new quote"], ["1 to 9 projects", "5%"], ["10 to 24 projects", "10%"], ["25 or more projects", "15%"]]);
  assert.match(textOf(table), /Repeat discount by qualifying projects in the preceding 365 days/);
  assert.match(text, /does not stack with another discount/);
  assert.match(text, /approvals are never reused/);
});

test("Pricing: the mode cards say whether each service can be bought now, and only from the publication", () => {
  const stateOf = (read: Publication, name: string): string => {
    const found = [...page("pricing").html(read).matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]).find((item) => headings(item)[0]?.text === name);
    assert.ok(found !== undefined, name);
    return textOf(found);
  };
  assert.match(stateOf(ALL, "CLEAN"), /Available for new projects/);
  assert.match(stateOf(CLEAN_ONLY, "HubSpot preparation"), /Not available for purchase/);
  assert.match(stateOf(UNAVAILABLE, "Salesforce preparation"), /Availability cannot be read right now/);
  assert.doesNotMatch(stateOf(UNAVAILABLE, "CLEAN"), /Available for new projects/);
});

test("Pricing: the estimator is a labelled form, the account link goes to sign-in, and a visitor without JavaScript is told what to read instead", () => {
  const html = page("pricing").html(ALL);
  assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Billable source units<\/label>/);
  assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Service<\/label>/);
  assert.match(html, /<button[^>]*type="submit"[^>]*>Show the indicative band<\/button>/);
  assert.match(html, /role="status"/);
  assert.match(textOf(html), /Enter a number to see the indicative band\./);
  assert.match(html, /<noscript>[\s\S]*The estimate needs JavaScript\. The table above shows every band and price\.[\s\S]*<\/noscript>/);
  const account = linkTexts(html).filter((link) => link.text === "Sign in or create an account");
  assert.deepEqual(account.map((link) => link.href), [SIGN_IN]);
  assert.deepEqual([...html.matchAll(/<option[^>]*value="([^"]*)"/g)].map((match) => match[1]), ["CLEAN", "HUBSPOT", "SALESFORCE"]);
});

// ---- Sample delivery ------------------------------------------------------------------------------------------------------------------

test("Sample delivery: it says at the top that everything is invented, and its numbers reconcile in the markup a visitor reads", () => {
  const html = page("sample").html(ALL);
  const text = textOf(html);
  assert.ok(text.indexOf("Synthetic sample data") < text.indexOf("Sample report"), "the label comes before the report");
  assert.match(text, /Everything on this page is invented\. No customer, logo, quote or import shown here is real, and none of this data was ever imported anywhere\./);
  assert.match(text, /The report of a free data health check on one invented file of 12,480 contacts\./);
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((match) => [...match[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => [...(row[1] ?? "").matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => textOf(cell[1] ?? ""))));
  assert.deepEqual(tables[0], [
    ["Measure", "Count", "Out of", "Share"],
    ["Contacts in the file", "12,480", "Not applicable", "Not applicable"],
    ["Contacts in duplicate candidate groups", "428", "12,480 contacts", "3.4%"],
    ["Contacts whose email address is not valid", "191", "12,480 contacts", "1.5%"],
    ["Contacts with no company", "1,137", "12,480 contacts", "9.1%"],
    ["Target settings to fix before an import", "3", "Not applicable", "Not applicable"],
  ]);
  assert.deepEqual(tables[1], [
    ["Output file", "Rows", "Source rows", "Unified with approval"],
    ["contacts-clean.csv", "12,266", "12,480", "214"],
    ["companies-clean.csv", "2,951", "3,204", "253"],
  ]);
  assert.match(text, /12,480 source rows, less 214 unified with approval, leave 12,266 output contacts\./);
  assert.match(text, /A duplicate candidate is a pair worth reviewing, not a confirmed duplicate\./);
  assert.equal(count(html, "<ol"), 1);
  assert.match(text, /It is not a check of your own data: the free data health check is\./);
  assert.match(text, /Compare the counts in the destination with the counts in the report\./);
  assert.doesNotMatch(text, /@|https?:\/\//, "an invented sample carries no address");
});

// ---- Data handling --------------------------------------------------------------------------------------------------------------------

test("Data handling: what is processed, isolation, what a model sees, who decides, the full retention schedule and what deletion does not cover", () => {
  const html = page("security").html(ALL);
  const text = textOf(html);
  assert.deepEqual(headings(html).filter((heading) => heading.level === 2).map((heading) => heading.text), [
    "What Kauro processes",
    "How customers are kept apart",
    "What a model may see",
    "Who decides",
    "How long each kind of data stays",
    "What deletion does not cover",
    "What this page does not claim",
    "Read the terms or ask a question",
  ]);
  const table = /<table[\s\S]*?<\/table>/.exec(html)?.[0] ?? "";
  assert.equal(count(table, "<tr>"), RETENTION_ROWS.length + 1);
  for (const row of RETENTION_ROWS) {
    assert.ok(textOf(table).includes(row.subject), row.subject);
    assert.ok(textOf(table).includes(row.rule), row.rule);
  }
  assert.match(table, /<th scope="row">/);
  for (const claim of [
    "A download link works for 15 minutes.",
    "A defect in Kauro's work can be reported for 30 days after the package is prepared, and Kauro aims to repair a verified material defect within 5 business days.",
    "a claim made after they are removed may need the exact source files to be uploaded again",
    "Do not upload credentials or secrets, full payment card data, or health data.",
    "A request for another agency's project is answered exactly like a request for a project that does not exist.",
    "it receives only a limited context that Kauro selects, never your files as a whole. It cannot approve a change and it cannot write to your CRM.",
    "A copy your agency downloaded stays with your agency",
    "has not been through an independent security certification and does not claim one",
    "does not guarantee that you meet any regulation",
  ]) assert.ok(text.includes(claim), claim);
  for (const route of [ROUTE.processing, ROUTE.privacy, ROUTE.contact]) assert.ok(hrefsOf(html).includes(route), route);
});

// ---- Contact --------------------------------------------------------------------------------------------------------------------------

test("Contact: a labelled fit form with the buyer-type question, the api's vocabularies, no file field, and no way to submit without a script", () => {
  const html = page("contact").html(ALL);
  const text = textOf(html);
  assert.match(html, /<form[^>]*\smethod="post"/, "an unscripted submit is a POST, never a GET that would put an address in a link");
  assert.doesNotMatch(html, /<form[^>]*\saction=/);
  assert.match(html, /<form[^>]*\snovalidate/i);
  assert.match(html, /<noscript>[\s\S]*This form needs JavaScript to send your inquiry\.[\s\S]*<\/noscript>/);
  assert.match(html, /<fieldset[^>]*>\s*<legend>Who will use Kauro\?<\/legend>/);
  assert.deepEqual([...html.matchAll(/<input[^>]*type="radio"[^>]*value="([^"]*)"/g)].map((match) => match[1]), ["agency", "in-house"]);
  assert.match(text, /An agency preparing data for clients/);
  assert.match(text, /A company working on its own data/);
  const options = (name: string): string[] => [...((new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`).exec(html)?.[0] ?? "").matchAll(/<option[^>]*value="([^"]*)"/g))].map((match) => match[1] ?? "");
  assert.deepEqual(options("destination"), ["", ...DESTINATIONS]);
  assert.deepEqual(options("recordBand"), ["", ...RECORD_BANDS.map((band) => band.value)]);
  assert.deepEqual(options("timing"), ["", ...TIMINGS]);
  for (const control of html.matchAll(/<(input|select|textarea)\s([^>]*)>/g)) {
    const id = /\sid="([^"]*)"|^id="([^"]*)"/.exec(` ${control[2]}`);
    assert.ok(id !== null, `a control has an id: ${control[0]}`);
    assert.ok(new RegExp(`<label[^>]*\\sfor="${id?.[1] ?? id?.[2]}"`).test(html), `a label for ${id?.[1] ?? id?.[2]}`);
  }
  assert.doesNotMatch(html, /type="(file|password|hidden)"/);
  for (const [name, token] of [["contactName", "name"], ["contactEmail", "email"], ["companyName", "organization"]] as const) assert.match(html, new RegExp(`name="${name}"[^>]*autoComplete="${token}"|autoComplete="${token}"[^>]*name="${name}"`, "i"), `${name} carries its autocomplete purpose`);
  assert.match(html, /type="email"/);
  assert.match(html, /<button[^>]*type="submit"[^>]*>Send inquiry<\/button>/);
  assert.match(html, /role="status"/);
  assert.match(text, /Describe the task, not the data: no credentials, keys or customer records\./);
  assert.match(text, /Do not attach CRM exports, and do not paste records, passwords or keys into any field\./);
  assert.match(text, /Up to 2000 characters/);
  assert.match(text, /All fields are required except the last one\./);
  assert.doesNotMatch(html, /aria-invalid="true"|kauro-error-summary/, "a form nobody has filled in shows no error");
});

// ---- Service status -------------------------------------------------------------------------------------------------------------------

test("Service status: the published services and the time observed, or an honest unavailable state that claims neither running nor down", () => {
  const read = textOf(page("status").html(ALL));
  assert.match(read, /Observed at 2026-10-02 09:30 UTC\. Reload this page for a new reading; it does not update on a schedule\./);
  assert.match(read, /CLEAN.*Available for new projects.*HubSpot.*Available for new projects.*Salesforce.*Available for new projects/);
  assert.match(read, /No incident summary is published on this page yet\. That is not a statement that none is open\./);
  const limited = textOf(page("status").html(publication(entry("CLEAN", "AVAILABLE_LIMITED"))));
  assert.match(limited, /CLEAN.*Available for new projects, within the published limits/);
  assert.doesNotMatch(limited, /HubSpot|Salesforce/, "a service the publication does not list is not on the status page");
  const none = textOf(page("status").html(NOTHING));
  assert.match(none, /lists no service as available for new projects right now/);
  const html = page("status").html(UNAVAILABLE);
  const unread = textOf(html);
  assert.match(unread, /Status cannot be shown/);
  assert.match(unread, /Kauro could not read its own service publication just now, so it shows no status\./);
  for (const banned of [/all systems/i, /operational/i, /Available for new projects/, /Observed at/, /No incident summary/, /CLEAN|HubSpot|Salesforce/]) assert.doesNotMatch(unread, banned, String(banned));
  assert.ok(hrefsOf(html).includes(ROUTE.contact));
});

// ---- Help -----------------------------------------------------------------------------------------------------------------------------

test("Help: an index of seven static guides that link to their sections, each with a heading and a summary, and the version of the guides", () => {
  const html = page("help").html(ALL);
  const text = textOf(html);
  const index = /<nav[^>]*aria-label="Guides"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
  const targets = hrefsOf(index);
  assert.deepEqual(targets, ["#guide-files", "#guide-target", "#guide-approval", "#guide-payment", "#guide-stages", "#guide-retention", "#guide-support"]);
  assert.deepEqual(headings(html).filter((heading) => heading.level === 2).map((heading) => heading.text), ["Prepare your files", "Confirm your target settings", "Approve the plan", "Pay for a project", "Import in stages and return receipts", "How long files stay", "Ask for help"]);
  assert.match(text, /Guide version 1\.0, last changed 2026-09-29/);
  for (const claim of ["up to 50 files, up to 2 GB for each file, up to 800 columns in a table", "180 days after the last confirmation", "The quote stays valid for 14 days", "Pressing Enter never approves anything", "An arbitrary file marked as a success is not proof", "Never email a CRM export or a password"]) assert.ok(text.includes(claim), claim);
  assert.ok(hrefsOf(html).includes(ROUTE.contact));
  assert.doesNotMatch(html, /<form|<input|<button|type="search"/, "search is not offered yet");
});

// ---- Unsubscribe ----------------------------------------------------------------------------------------------------------------------

test("Communication preferences: the page says it cannot stop messages yet, changes nothing, and offers a written route instead", () => {
  const html = page("unsubscribe").html(ALL);
  const text = textOf(html);
  assert.match(text, /This page cannot stop messages yet/);
  assert.match(text, /Turning off optional messages from this link is not available yet\. This page has not changed any setting and has not recorded any choice\./);
  assert.match(text, /Notices about an account, a payment, your files or a support case are not optional messages\./);
  assert.doesNotMatch(html, /<form|<input|<button|<select|<textarea/, "nothing on the page can be pressed to stop a message");
  assert.doesNotMatch(text, /you have been unsubscribed|preferences (saved|updated)|successfully/i, "no success is claimed");
  assert.deepEqual(hrefsOf(html), [ROUTE.contact]);
});

test("the unsubscribe route never reads the token it is reached with, and no public route reads a cookie, a header or the environment", () => {
  const route = readFileSync(join(webRoot, "src", "app", "(public)", "unsubscribe", "[token]", "page.tsx"), "utf8");
  assert.equal(/\bparams\b/.test(route), false, "the token in the address is not read");
  assert.equal(/\btoken\b/.test(route.replaceAll(/\/\/.*$/gm, "")), false);
  const sources = walk(join(webRoot, "src", "app", "(public)")).filter((file) => /\.(ts|tsx)$/.test(file));
  assert.ok(sources.length >= 12, "the public routes are there");
  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    assert.equal(/\b(cookies|headers)\(/.test(source) || /process\.env/.test(source), false, `${relative(webRoot, file)} reads no request state and no environment`);
  }
});

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// ---- the frame ------------------------------------------------------------------------------------------------------------------------

test("the frame: the skip link is first, one header, one main, one footer, two named navigations, the current page marked once, and a sign-in link", () => {
  const frame = (current: string | null): string =>
    render(createElement(SiteFrame, { signInHref: SIGN_IN, nav: createElement(NavList, { items: MAIN_NAV, current, label: "site.nav.main.label" }), children: createElement("p", null, "Body") }));
  const html = frame("/pricing");
  assert.match(html, /^<a class="kauro-site-skip" href="#kauro-main">Skip to main content<\/a>/);
  assert.equal(count(html, "<header"), 1);
  assert.equal(count(html, "<main"), 1);
  assert.match(html, /<main id="kauro-main" class="kauro-site-main" tabindex="-1">/);
  assert.equal(count(html, "<footer"), 1);
  assert.deepEqual([...html.matchAll(/<nav[^>]*aria-label="([^"]*)"/g)].map((match) => match[1]), ["Main", "Footer"]);
  assert.equal(count(html, 'aria-current="page"'), 1);
  assert.match(html, /<a[^>]*href="\/pricing"[^>]*aria-current="page"[^>]*>Pricing<\/a>|<a[^>]*aria-current="page"[^>]*href="\/pricing"[^>]*>Pricing<\/a>/);
  assert.equal(count(frame(null), 'aria-current="page"'), 0);
  assert.equal(count(frame("/unsubscribe/anything"), 'aria-current="page"'), 0, "a page outside the navigation marks nothing");
  assert.deepEqual(linkTexts(html).map((link) => link.text), ["Skip to main content", "Kauro", ...MAIN_NAV.map((item) => textOf(PUBLIC_COPY[item.label])), "Sign in", ...FOOTER_NAV.map((item) => PUBLIC_COPY[item.label])]);
  assert.deepEqual(linkTexts(html).filter((link) => link.text === "Sign in").map((link) => link.href), [SIGN_IN]);
  assert.match(textOf(html), /Kauro prepares exported CRM files\. It does not connect to, change or delete records in a live CRM\./);
  assert.doesNotMatch(html, /<html|<body|<head[ >]/, "the frame renders inside the document the root layout draws");
  assert.match(html, /<p>Body<\/p>/);
});

test("every public route of the site has its route file, each names its metadata, and the layout and the navigation are the frame's", () => {
  const base = join(webRoot, "src", "app", "(public)");
  const files: ReadonlyArray<readonly [PageKey, string]> = [
    ["home", "page.tsx"],
    ["how", "how-it-works/page.tsx"],
    ["services", "supported-services/page.tsx"],
    ["pricing", "pricing/page.tsx"],
    ["sample", "sample-delivery/page.tsx"],
    ["security", "security/page.tsx"],
    ["contact", "contact/page.tsx"],
    ["status", "status/page.tsx"],
    ["help", "help/page.tsx"],
    ["unsubscribe", "unsubscribe/[token]/page.tsx"],
  ];
  assert.deepEqual(files.map(([key]) => key), SITE_PAGES.map((candidate) => candidate.key));
  for (const [key, file] of files) {
    assert.ok(existsSync(join(base, file)), file);
    const source = readFileSync(join(base, file), "utf8");
    assert.match(source, new RegExp(`export const metadata: Metadata = pageMetadata\\("${key}"\\);`), `${file} names its metadata`);
    assert.match(source, /export default (async )?function /, file);
  }
  for (const file of ["layout.tsx", "main-nav.tsx", "public.css"]) assert.ok(existsSync(join(base, file)), file);
  const layout = readFileSync(join(base, "layout.tsx"), "utf8");
  assert.match(layout, /import "\.\/public\.css";/);
  assert.match(layout, /template: "%s \| Kauro"/);
  assert.match(readFileSync(join(base, "main-nav.tsx"), "utf8"), /^"use client";/);
  for (const key of ["legal/terms/route.ts", "legal/privacy/route.ts", "legal/data-processing/route.ts"]) assert.ok(existsSync(join(base, key)), key);
});
