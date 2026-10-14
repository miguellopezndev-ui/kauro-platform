// UI49 (submit): the one-click body of RFC 8058 and the answer it gets. Pure apart from the injected fetcher; held by test/public-pages.test.ts.
export const OPT_OUT_BODY = "List-Unsubscribe=One-Click";
export const optOutPath = (token: string): string => `/api/v1/public/outreach/opt-out/${encodeURIComponent(token)}`;

export type OptOutOutcome = "DONE" | "LIMITED" | "FAILED";

/** Posts exactly the RFC body, same origin, no credential. Only a 200 is DONE; a 429 is LIMITED; anything else (or a network failure) is FAILED. Never throws. */
export async function submitOptOut(token: string, fetcher: typeof fetch = fetch): Promise<OptOutOutcome> {
  try {
    const response = await fetcher(optOutPath(token), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: OPT_OUT_BODY,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 200) return "DONE";
    return response.status === 429 ? "LIMITED" : "FAILED";
  } catch {
    return "FAILED";
  }
}
