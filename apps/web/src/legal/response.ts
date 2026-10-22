// The HTTP response of a legal document (design D-LEGAL-1). A route handler bypasses the layouts, so this module writes the whole page:
// one self-contained document with its own style block under the request nonce (the site's policy has no style attribute and no
// foreign origin: D-SEC-1), no script, no form and no absolute URL. Pure: the nonce and the stylesheet are arguments.
//
// The status is the document's own: 200 for a published document and 503 for anything else, with no version label in the body, the
// title or a header, and no word about a version or an effective date, because none exists.
import { LEGAL_DOCUMENTS, type PublishedLegal, type RenderedLegal } from "./render.ts";

/** The grammar of the proxy's nonce (128 bits of base64: security-headers.ts newNonce). */
export const NONCE_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

/** The header that carries a published document's version label, for a client that records what it read. */
export const VERSION_HEADER = "x-kauro-document-version";

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** The rules of a legal page: tokens only (so the one theme applies), one column of readable measure, a skip link that shows on focus. */
export const LEGAL_CSS = `
body { display: flex; flex-direction: column; min-height: 100dvh; margin: 0; background: var(--kauro-color-background); color: var(--kauro-color-text); }
.kauro-legal-main { flex: 1 0 auto; width: 100%; }
.kauro-legal-skip { position: absolute; left: var(--kauro-space-4); top: var(--kauro-space-2); z-index: 2; padding: var(--kauro-space-2) var(--kauro-space-4); background: var(--kauro-color-primary); color: var(--kauro-color-on-primary); border-radius: var(--kauro-radius); font-weight: 600; transform: translateY(-200%); }
.kauro-legal-skip:focus { transform: none; }
.kauro-legal-bar { box-sizing: border-box; max-width: 80rem; margin: 0 auto; padding: var(--kauro-space-4) clamp(1.25rem, 4.5vw, 3rem); }
.kauro-legal-bar a { display: inline-flex; align-items: center; min-height: 2.75rem; color: var(--kauro-color-text); font-family: var(--kauro-display-family); font-size: 1.5rem; font-weight: 650; letter-spacing: -0.035em; text-decoration: none; }
.kauro-legal-main { box-sizing: border-box; max-width: 46rem; margin: 0 auto; padding: clamp(2.5rem, 6vw, 5rem) clamp(1.25rem, 4.5vw, 3rem) var(--kauro-space-8); }
.kauro-legal-main:focus { outline: none; }
.kauro-legal-main:has(.kauro-legal-card) { display: flex; flex-direction: column; justify-content: center; padding-block: clamp(2rem, 6vw, 4rem); }
.kauro-legal-main h1 { margin: 0 0 var(--kauro-space-4); font-family: var(--kauro-display-family); font-size: clamp(2.25rem, 1.6rem + 2.6vw, 3.25rem); font-weight: 600; line-height: 1.05; letter-spacing: -0.035em; text-wrap: balance; }
.kauro-legal-main h2 { margin: var(--kauro-space-7) 0 var(--kauro-space-3); padding-top: var(--kauro-space-5); border-top: 1px solid var(--kauro-color-border); font-family: var(--kauro-display-family); font-size: 1.375rem; font-weight: 600; line-height: var(--kauro-line-height-heading); letter-spacing: -0.02em; }
.kauro-legal-main p, .kauro-legal-main li { margin: 0 0 var(--kauro-space-3); line-height: 1.65; overflow-wrap: anywhere; }
.kauro-legal-main ul { margin: 0 0 var(--kauro-space-3); padding-left: var(--kauro-space-5); }
.kauro-legal-lead { color: var(--kauro-color-text-muted); font-size: 1.1875rem; line-height: 1.55; }
.kauro-legal-meta { display: inline-block; margin-top: var(--kauro-space-2); padding: var(--kauro-space-1) var(--kauro-space-3); border: 1px solid var(--kauro-color-border); border-radius: var(--kauro-radius); background: var(--kauro-color-raised); color: var(--kauro-color-text-muted); font-size: var(--kauro-font-size-dense); }
.kauro-legal-meta code { font-family: var(--kauro-mono-family); overflow-wrap: anywhere; }
.kauro-legal-main a, .kauro-legal-foot a { color: var(--kauro-color-primary); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
.kauro-legal-foot { border-top: 1px solid var(--kauro-color-border); background: var(--kauro-color-surface); font-size: var(--kauro-font-size-dense); }
.kauro-legal-foot nav { box-sizing: border-box; max-width: 80rem; margin: 0 auto; padding: var(--kauro-space-5) clamp(1.25rem, 4.5vw, 3rem) var(--kauro-space-6); }
.kauro-legal-foot ul { display: flex; flex-wrap: wrap; gap: 0 var(--kauro-space-5); margin: 0; padding: 0; list-style: none; }
.kauro-legal-foot a { display: inline-flex; align-items: center; min-height: 2.75rem; color: var(--kauro-color-text); text-decoration: none; }
.kauro-legal-foot a:hover { text-decoration: underline; }
.kauro-legal-foot a[aria-current="page"] { font-weight: 700; text-decoration: underline; text-decoration-color: var(--kauro-color-primary); text-decoration-thickness: 2px; }
.kauro-legal-card { position: relative; margin-top: var(--kauro-space-4); border: 1px solid var(--kauro-color-border); border-radius: 1rem; background: var(--kauro-color-raised); box-shadow: 0 2.5rem 4rem -2.25rem color-mix(in srgb, var(--kauro-color-ink) 60%, transparent); transform: rotate(1.5deg); }
.kauro-legal-main .kauro-legal-card-bar { display: flex; gap: 0.875rem; margin: 0; padding: 0.75rem 1.5rem; border-bottom: 1px solid var(--kauro-color-border); background: var(--kauro-color-surface); border-radius: 1rem 1rem 0 0; font-size: 0.8125rem; line-height: 1.4; }
.kauro-legal-card-bar span:first-child { font-family: var(--kauro-display-family); font-weight: 700; letter-spacing: -0.02em; }
.kauro-legal-card-bar span + span { padding-left: 0.875rem; border-left: 1px solid var(--kauro-color-border); color: var(--kauro-color-text-muted); }
.kauro-legal-card-body { padding: clamp(1.5rem, 4vw, 2.5rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 4.5rem); }
.kauro-legal-card-body > :last-child { margin-bottom: 0; }
.kauro-legal-stamp { position: absolute; right: clamp(1rem, 4vw, 2rem); bottom: clamp(1rem, 3vw, 1.5rem); padding: 0.4375rem 0.75rem; border: 2px solid var(--kauro-color-primary); border-radius: 0.3125rem; background: var(--kauro-color-raised); box-shadow: inset 0 0 0 3px var(--kauro-color-raised), inset 0 0 0 4px var(--kauro-color-primary); color: var(--kauro-color-primary); font-family: var(--kauro-mono-family); font-size: 0.875rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; transform: rotate(-8deg); }
`;

function published(document: PublishedLegal): string {
  const sections = document.sections
    .map((section, index) => {
      const id = `section-${index + 1}`;
      const paragraphs = section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
      const items =
        section.items === undefined || section.items.length === 0
          ? ""
          : `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
      return `<section aria-labelledby="${id}"><h2 id="${id}">${escapeHtml(section.heading)}</h2>${paragraphs}${items}</section>`;
    })
    .join("");
  return [
    `<h1>${escapeHtml(document.title)}</h1>`,
    `<p class="kauro-legal-lead">${escapeHtml(document.primary)}</p>`,
    `<p class="kauro-legal-meta">Version <code>${escapeHtml(document.version)}</code>. Effective ${escapeHtml(document.effectiveDate)}.</p>`,
    sections,
  ].join("");
}

function refused(): string {
  // no fact and no reason is named: the page says only that the document is not there yet
  // set as the not-found page is (A10 §8): one tilted card, its stamp across the corner
  return [
    '<div class="kauro-legal-card">',
    '<p class="kauro-legal-card-bar" aria-hidden="true"><span>Kauro</span><span>Legal documents</span></p>',
    '<div class="kauro-legal-card-body">',
    "<h1>This document is not published yet</h1>",
    "<p class=\"kauro-legal-lead\">Kauro has not made this page available to read yet.</p>",
    "<p>The details of the company that operates the service are still being confirmed. Until they are, and the document is published, no account can be activated under it.</p>",
    '<p>To ask a question, use the <a href="/contact">contact page</a>.</p>',
    "</div>",
    '<span class="kauro-legal-stamp" aria-hidden="true">Not published</span>',
    "</div>",
  ].join("");
}

function nav(current: string): string {
  const links = LEGAL_DOCUMENTS.map((entry) => {
    const here = entry.key === current ? ' aria-current="page"' : "";
    return `<li><a href="${entry.route}"${here}>${escapeHtml(entry.title)}</a></li>`;
  });
  return `<nav aria-label="Legal documents"><ul>${links.join("")}</ul></nav>`;
}

/** The whole page and its status. `css` is the stylesheet the caller wants (the design tokens and LEGAL_CSS). */
export function legalResponse(document: RenderedLegal, options: { readonly nonce: string; readonly css: string }): Response {
  if (!NONCE_PATTERN.test(options.nonce)) throw new Error("CSP_NONCE_MISSING: a legal page is written under the nonce the proxy minted for the request");
  const body = document.published ? published(document) : refused();
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">` +
    `<title>${escapeHtml(document.title)} | Kauro</title><style nonce="${options.nonce}">${options.css}</style></head>` +
    `<body><a class="kauro-legal-skip" href="#kauro-main">Skip to the document</a>` +
    `<header class="kauro-legal-bar"><a href="/">Kauro</a></header>` +
    `<main id="kauro-main" class="kauro-legal-main" tabindex="-1">${body}</main>` +
    `<footer class="kauro-legal-foot">${nav(document.key)}</footer></body></html>`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  if (document.published) headers.set(VERSION_HEADER, document.version);
  return new Response(html, { status: document.published ? 200 : 503, headers });
}
