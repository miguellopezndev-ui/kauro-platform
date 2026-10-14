// The copy of the agency screens built in stage 2 (design D-COPY-1): the registry's primary sentence of each screen word for word, and the
// rest in the same plain English. Keys are `screen.<area>.…` so no id is shared with copy/en.ts or copy/public.ts. The A3 lint runs over
// all of it (the free step is "Free data health check", never an audit; Prepared for import, never Imported; no founding line before B10).
//
// This file only assembles: each area owns one module under copy/screens/ and adds its keys there, so two lanes never edit the same file.
// A key defined by two areas is refused when the catalogue loads (the second definition would silently replace the first).
import { ACCOUNT_COPY } from "./screens/account.ts";
import { APPROVAL_COPY } from "./screens/approval.ts";
import { BILLING_COPY } from "./screens/billing.ts";
import { HEALTH_CHECK_COPY } from "./screens/health-check.ts";
import { KIT_COPY } from "./screens/kit.ts";
import { PAYMENT_COPY } from "./screens/payment.ts";
import { PROCESSING_COPY } from "./screens/processing.ts";
import { QUOTE_COPY } from "./screens/quote.ts";
import { SETTINGS_COPY } from "./screens/settings.ts";
import { SOURCES_COPY } from "./screens/sources.ts";
import { SUPPORT_COPY } from "./screens/support.ts";
import { WORKSPACE_COPY } from "./screens/workspace.ts";

const AREAS = [ACCOUNT_COPY, APPROVAL_COPY, BILLING_COPY, HEALTH_CHECK_COPY, KIT_COPY, PAYMENT_COPY, PROCESSING_COPY, QUOTE_COPY, SETTINGS_COPY, SOURCES_COPY, SUPPORT_COPY, WORKSPACE_COPY] as const;

const seen = new Set<string>();
for (const area of AREAS) {
  for (const id of Object.keys(area)) {
    if (seen.has(id)) throw new Error(`copy key ${id} is defined by two screen areas`);
    seen.add(id);
  }
}

export const SCREEN_COPY = {
  ...ACCOUNT_COPY,
  ...APPROVAL_COPY,
  ...BILLING_COPY,
  ...HEALTH_CHECK_COPY,
  ...KIT_COPY,
  ...PAYMENT_COPY,
  ...PROCESSING_COPY,
  ...QUOTE_COPY,
  ...SETTINGS_COPY,
  ...SOURCES_COPY,
  ...SUPPORT_COPY,
  ...WORKSPACE_COPY,
} as const satisfies Readonly<Record<string, string>>;

export type ScreenCopyId = keyof typeof SCREEN_COPY;
