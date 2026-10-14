// Every area's implemented screens, in one list. A lane adds its ids to its own module; this index only names the modules.
import { ACCOUNT_IMPLEMENTED } from "./account.ts";
import { BILLING_IMPLEMENTED } from "./billing.ts";
import { FINANCE_IMPLEMENTED } from "./finance.ts";
import { HEALTH_CHECK_IMPLEMENTED } from "./health-check.ts";
import { PAYMENTS_IMPLEMENTED } from "./payments.ts";
import { PROCESSING_IMPLEMENTED } from "./processing.ts";
import { PUBLIC_IMPLEMENTED } from "./public.ts";
import { SETTINGS_IMPLEMENTED } from "./settings.ts";
import { SOURCES_IMPLEMENTED } from "./sources.ts";
import { SUPPORT_IMPLEMENTED } from "./support.ts";
import { WORKSPACE_IMPLEMENTED } from "./workspace.ts";

export const IMPLEMENTED_BY_AREA: Readonly<Record<string, readonly string[]>> = {
  account: ACCOUNT_IMPLEMENTED,
  billing: BILLING_IMPLEMENTED,
  finance: FINANCE_IMPLEMENTED,
  "health-check": HEALTH_CHECK_IMPLEMENTED,
  payments: PAYMENTS_IMPLEMENTED,
  processing: PROCESSING_IMPLEMENTED,
  public: PUBLIC_IMPLEMENTED,
  settings: SETTINGS_IMPLEMENTED,
  sources: SOURCES_IMPLEMENTED,
  support: SUPPORT_IMPLEMENTED,
  workspace: WORKSPACE_IMPLEMENTED,
};
