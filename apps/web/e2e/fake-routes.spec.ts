// The ContractFakeAgencyApi behind the real TLS edge (B11 design D-E2E-2, section 6). These are harness checks, not acceptance cases: no
// case of B11 is demonstrated by this file. They hold the mounted fake to what a browser spec will rely on: a planned operation is
// answered exactly as scripted (under the page's own origin and policy), a served route is never answered, a request that breaks a rule
// is refused and recorded, and a script the contract refuses is refused by the control endpoint. The planned operation is the edge's
// harness probe: since the stage-1 integration W2's session routes are served, and the generated client plans nothing (D-INT1-5).
import { expect, type APIRequestContext, test } from "@playwright/test";
import { CONTROL_PREFIX, type ReplyScript } from "./support/fake-routes.ts";

const CORRELATION = "0199c1a2-7b3d-7c4e-8a5f-00000000000a";
const SERVED_AGENCY = "/api/v1/agencies/0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1";
const PROBE = "/api/v1/__kauro-harness/probe";
const PROBE_BODY = { probe: "scripted" };

async function reset(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${CONTROL_PREFIX}reset`)).status()).toBe(204);
}

async function reply(request: APIRequestContext, operationId: string, script: ReplyScript) {
  return request.post(`${CONTROL_PREFIX}reply`, { data: { operationId, script } });
}

test("harness: the planned harness operation is answered by the fake exactly as scripted, to the page's own same-origin fetch, and the call is recorded without a violation", async ({ page, request }) => {
  await reset(request);
  expect((await reply(request, "HarnessProbe", { kind: "BODY", status: 200, body: PROBE_BODY })).status()).toBe(204);
  const policyViolations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) policyViolations.push(message.text());
  });
  await page.goto("/no-such-page");
  const answered = await page.evaluate(
    async ({ correlation, probe }) => {
      const response = await fetch(probe, { headers: { "X-Correlation-Id": correlation }, cache: "no-store", credentials: "same-origin" });
      return { status: response.status, type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), echoed: response.headers.get("x-correlation-id"), body: (await response.json()) as unknown };
    },
    { correlation: CORRELATION, probe: PROBE },
  );
  expect(answered).toEqual({ status: 200, type: "application/json", cache: "no-store", echoed: CORRELATION, body: PROBE_BODY });
  expect(policyViolations).toEqual([]);

  const calls = (await (await request.get(`${CONTROL_PREFIX}calls`)).json()) as { calls: Array<{ operationId: string; correlationId: string; violations: string[] }> };
  expect(calls.calls.map((call) => [call.operationId, call.correlationId, call.violations])).toEqual([["HarnessProbe", CORRELATION, []]]);
  expect(await (await request.get(`${CONTROL_PREFIX}violations`)).json()).toEqual({ violations: [] });
  await reset(request);
});

test("harness: a served route and an unknown path are forwarded and never answered by the fake, and the fake records nothing", async ({ request }) => {
  await reset(request);
  await reply(request, "HarnessProbe", { kind: "BODY", status: 200, body: PROBE_BODY });
  for (const path of [SERVED_AGENCY, "/api/v1/sessions/current", "/api/v1/nothing-here"]) {
    const response = await request.get(path, { headers: { "X-Correlation-Id": CORRELATION } });
    // every answer of the fake echoes the correlation id: the application's own refusal does not
    expect(response.headers()["x-correlation-id"], path).toBeUndefined();
    expect(response.status(), path).not.toBe(501);
  }
  expect(await (await request.get(`${CONTROL_PREFIX}calls`)).json()).toEqual({ calls: [] });
  await reset(request);
});

test("harness: a request that breaks a rule is answered with the operation's own refusal, recorded, and forgotten by reset", async ({ request }) => {
  await reset(request);
  await reply(request, "HarnessProbe", { kind: "BODY", status: 200, body: PROBE_BODY });
  const refused = await request.get(PROBE);
  expect(refused.status()).toBe(400);
  expect(refused.headers()["content-type"]).toBe("application/problem+json");
  expect(((await refused.json()) as { code: string }).code).toBe("INVALID_REQUEST");
  const { violations } = (await (await request.get(`${CONTROL_PREFIX}violations`)).json()) as { violations: string[] };
  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(/^HarnessProbe: X-Correlation-Id/);
  await reset(request);
  expect(await (await request.get(`${CONTROL_PREFIX}violations`)).json()).toEqual({ violations: [] });
});

test("harness: a script the contract refuses is refused by the control endpoint with its reason, and nothing is scripted", async ({ request }) => {
  await reset(request);
  for (const served of ["GetAgency", "getCurrentSession"]) {
    const answer = await reply(request, served, { kind: "BODY", status: 200, body: {} });
    expect(answer.status(), served).toBe(422);
    expect(((await answer.json()) as { error: string }).error, served).toMatch(/^SERVED_ROUTE/);
  }
  const invalid = await reply(request, "HarnessProbe", { kind: "BODY", status: 200, body: { probe: 1 } });
  expect(invalid.status()).toBe(422);
  expect(((await invalid.json()) as { error: string }).error).toMatch(/^REPLY_INVALID/);
  const unscripted = await request.get(PROBE, { headers: { "X-Correlation-Id": CORRELATION } });
  expect(unscripted.status()).toBe(501);
  await reset(request);
});
