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

export function registryScreens(): ReadonlyMap<string, RegistryScreen> {
  return new Map(
    screens().map((row): readonly [string, RegistryScreen] => {
      const id = text(row, "id");
      return [id, { id, origin: text(row, "origin"), route: typeof row["route"] === "string" ? row["route"] : "", primaryCopy: typeof row["primaryCopy"] === "string" ? row["primaryCopy"] : "" }];
    }),
  );
}
