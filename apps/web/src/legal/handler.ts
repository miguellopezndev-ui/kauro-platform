// The route handler of a legal document (design D-LEGAL-1): the one place the shipped operator facts meet the renderer and the response.
// Each route file under src/app/(public)/legal/<document>/ is two exported lines that call legalHandler with its own key, so a route can
// serve its own document and no other.
import { renderTokenCss } from "@kauro/ui";
import { FACE_CSS } from "../server/faces.ts";
import { NONCE_REQUEST_HEADER } from "../server/security-headers.ts";
import { themeOfCookieHeader } from "../server/theme.ts";
import { parseOperatorFacts, type OperatorFacts } from "./facts.ts";
import shipped from "./operator-facts.json" with { type: "json" };
import { renderLegal, type LegalKey } from "./render.ts";
import { LEGAL_CSS, NONCE_PATTERN, legalResponse } from "./response.ts";

/** The facts the owner has provided, read strictly at load: today every fact is null, so no document is published (BLOCKED_OWNER). */
export const OPERATOR_FACTS: OperatorFacts = parseOperatorFacts(shipped);

// the faces (Order 10) are part of the page's one stylesheet, as in the root layout
const STYLESHEET = `${FACE_CSS}
${renderTokenCss()}${LEGAL_CSS}`;

/** The GET handler of one document. Synchronous: nothing it reads is remote. It refuses a request the proxy did not give a nonce. */
export function legalHandler(key: LegalKey, facts: OperatorFacts = OPERATOR_FACTS): (request: Request) => Response {
  return (request) => {
    const nonce = request.headers.get(NONCE_REQUEST_HEADER);
    // a page written without its nonce would run without its policy: refuse it, as the root layout does (D-SEC-1)
    if (nonce === null || !NONCE_PATTERN.test(nonce)) throw new Error("CSP_NONCE_MISSING");
    return legalResponse(renderLegal(key, facts), { nonce, css: STYLESHEET, theme: themeOfCookieHeader(request.headers.get("cookie")) });
  };
}
