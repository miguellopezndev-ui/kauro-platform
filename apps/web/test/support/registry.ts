// The screen registry of @kauro/contracts read into the four fields the public pages are held to. The registry's rows are open records;
// a row without one of the fields is a broken registry, so it throws here instead of comparing "undefined" with a page.
import { screens } from "@kauro/contracts/registry";

export interface RegistryScreen {
  readonly id: string;
  readonly origin: string;
  readonly route: string;
  readonly primaryCopy: string;
}

function text(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`screens.json: ${String(row["id"])} has no string ${field}`);
  return value;
}

/**
 * Primary copy whose rendered text is amended without editing the registry, which stays byte-identical to the authority (as amendment A3
 * §1.4 does for UI07 and UI18): each entry names its record, and only these screens may differ from screens.json.
 */
export const AMENDED_PRIMARY_COPY: Readonly<Record<string, { readonly text: string; readonly record: string }>> = {
  UI07: { text: "Request a free data health check.", record: "docs/design/ORDER11-ROUND2-PUBLIC.md, amendment R2-1 (owner's approval, 2026-10-21)" },
};

export function registryScreens(): ReadonlyMap<string, RegistryScreen> {
  return new Map(
    screens().map((row): readonly [string, RegistryScreen] => {
      const id = text(row, "id");
      const primaryCopy = AMENDED_PRIMARY_COPY[id]?.text ?? (typeof row["primaryCopy"] === "string" ? row["primaryCopy"] : "");
      return [id, { id, origin: text(row, "origin"), route: typeof row["route"] === "string" ? row["route"] : "", primaryCopy }];
    }),
  );
}
