import "server-only";
import { type HostConfig, parseHostPolicy } from "../host-config.ts";

// The only reader of the host environment values (D-SEC-2). The value is read once per process: a deployment's hosts do not change while it runs.
let cached: HostConfig | undefined;

export function hostConfig(): HostConfig {
  if (cached === undefined) {
    cached = parseHostPolicy({
      KAURO_ENV: process.env["KAURO_ENV"],
      KAURO_PUBLIC_ORIGIN: process.env["KAURO_PUBLIC_ORIGIN"],
      KAURO_APP_ORIGIN: process.env["KAURO_APP_ORIGIN"],
      KAURO_OPS_ORIGIN: process.env["KAURO_OPS_ORIGIN"],
    });
    // one line per process, the problem name only: a deployment that names its hosts wrongly serves no screen, and the operator must see why
    if (!cached.ok) console.error(`KAURO_HOST_CONFIG_INVALID ${cached.problem}`);
  }
  return cached;
}
