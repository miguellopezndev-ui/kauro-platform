/**
 * Certificate-verified database connections (AWS-DELTA I-2, Q-AWS-8). A deployment outside LOCAL connects to the managed
 * database over TLS and verifies the server: the trust anchor is the CA bundle the deployment mounts as a file, the certificate
 * must chain to it (rejectUnauthorized) and must name the host dialled (Node's default host name check; `host` reaches the
 * handshake as the server name). There is no option that turns verification off: `rejectUnauthorized` is the literal `true`.
 */
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
