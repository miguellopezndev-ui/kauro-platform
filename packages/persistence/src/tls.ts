/**
 * Certificate-verified database connections (AWS-DELTA I-2, Q-AWS-8). A deployment outside LOCAL connects to the managed
 * database over TLS and verifies the server: the trust anchor is the CA bundle the deployment mounts as a file, the certificate
 * must chain to it (rejectUnauthorized) and must name the host dialled (Node's default host name check; `host` reaches the
 * handshake as the server name). There is no option that turns verification off: `rejectUnauthorized` is the literal `true`.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export interface DatabaseTls {
  /** The PEM text of the CA (bundle) that signed the server certificate. */
  readonly ca: string;
}

export interface VerifiedSslOptions {
  readonly ca: string;
  readonly rejectUnauthorized: true;
}

/** The `ssl` option of a pg connection or pool for `tls`, or undefined when the connection is not TLS-configured (LOCAL only). */
export function sslOptionsOf(tls: DatabaseTls | undefined): VerifiedSslOptions | undefined {
  if (tls === undefined) return undefined;
  if (typeof tls.ca !== "string" || !tls.ca.includes("-----BEGIN CERTIFICATE-----")) throw new TypeError("database TLS requires a CA in PEM form");
  return { ca: tls.ca, rejectUnauthorized: true };
}

/** What a composition root hands over about one database login: the host and the secrets as the deployment names them. */
export interface ConnectionSecurityInput {
  readonly host: string;
  /** LOCAL only. Outside LOCAL the password is a mounted-secret file (I-3). */
  readonly password?: string;
  readonly passwordFile?: string;
  /** The CA file (KAURO_DB_TLS_CA_FILE); required outside LOCAL (I-2). */
  readonly tlsCaFile?: string;
}

export class ConnectionSecurityError extends Error {
  constructor(variable: string, problem: string) {
    super(`${variable}: ${problem}`);
    this.name = "ConnectionSecurityError";
  }
}

/**
 * The single rule every composition root that opens a PostgreSQL connection applies before it builds a pool or a client
 * (AWS-DELTA I-2, I-3): outside LOCAL the server certificate is verified against the CA file (no CA, no connection), the host is a
 * DNS name (pg gives the TLS layer no server name for an IP literal, so the name check would be against "localhost"), the password
 * is read from its file and the plain value is refused. In LOCAL, nothing is required. A refusal names the variable, never a value.
 */
export function connectionSecurityOf(environment: "LOCAL" | "SANDBOX" | "LIVE", input: ConnectionSecurityInput): { readonly password?: string; readonly tls?: DatabaseTls } {
  const local = environment === "LOCAL";
  if (input.password !== undefined && input.passwordFile !== undefined) throw new ConnectionSecurityError("KAURO_DB_PASSWORD_FILE", "is exclusive with the plain password");
  if (input.password !== undefined && !local) throw new ConnectionSecurityError("KAURO_DB_PASSWORD", "is accepted in the LOCAL environment only: SANDBOX and LIVE receive the password as a mounted secret file (KAURO_DB_PASSWORD_FILE)");
  if (!local && isIP(input.host) !== 0) throw new ConnectionSecurityError("KAURO_DB_HOST", "must be a DNS name outside LOCAL: the certificate is verified against the host name dialled");
  let password = input.password;
  if (input.passwordFile !== undefined) {
    password = readFileOf("KAURO_DB_PASSWORD_FILE", input.passwordFile).replace(/\r?\n$/, "");
    if (password === "") throw new ConnectionSecurityError("KAURO_DB_PASSWORD_FILE", "names an empty file");
  }
  let tls: DatabaseTls | undefined;
  if (input.tlsCaFile !== undefined) {
    const ca = readFileOf("KAURO_DB_TLS_CA_FILE", input.tlsCaFile);
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new ConnectionSecurityError("KAURO_DB_TLS_CA_FILE", "names a file that holds no PEM certificate");
    tls = { ca };
  } else if (!local) {
    throw new ConnectionSecurityError("KAURO_DB_TLS_CA_FILE", "is required outside LOCAL: the database connection verifies the server certificate against this CA");
  }
  return { ...(password === undefined ? {} : { password }), ...(tls === undefined ? {} : { tls }) };
}

function readFileOf(variable: string, path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    const code = e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string" ? String((e as NodeJS.ErrnoException).code) : "unreadable";
    throw new ConnectionSecurityError(variable, `names a file that cannot be read (${code})`);
  }
}
