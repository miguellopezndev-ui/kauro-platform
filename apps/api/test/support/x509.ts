/**
 * A self-signed X.509 v3 certificate for a test key pair, DER-encoded by hand and signed with node:crypto (no openssl, no
 * certificate library): the shape of the certificates Google's securetoken document publishes (an RSA public key signed
 * sha256WithRSAEncryption), so the GOOGLE_X509 key source is exercised against the documented format without the live endpoint.
 */
import { createSign, type KeyObject } from "node:crypto";

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 + n, content);
const NULL = Buffer.from([0x05, 0x00]);

function integer(value: Buffer): Buffer {
  const trimmed = value.length > 1 && value[0] === 0 ? value.subarray(1) : value;
  return tlv(0x02, (trimmed[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const out: number[] = [40 * a + b];
  for (const n of rest) {
    const chunk: number[] = [];
    let v = n;
    do {
      chunk.unshift(v & 0x7f);
      v >>= 7;
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] = (chunk[i] as number) | 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(ms: number): Buffer {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return tlv(0x17, Buffer.from(`${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`, "ascii"));
}

/** A PEM certificate of `keys.publicKey`, self-signed by `keys.privateKey`, for the common name `commonName`. */
export function selfSignedCertificatePem(keys: { readonly privateKey: KeyObject; readonly publicKey: KeyObject }, commonName: string, nowMs: number = Date.now()): string {
  const algorithm = sequence(oid("1.2.840.113549.1.1.11"), NULL);
  const name = sequence(set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName, "utf8")))));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(Buffer.from(String(nowMs).padStart(16, "0").slice(-16), "hex")),
    algorithm,
    name,
    sequence(utcTime(nowMs - 86_400_000), utcTime(nowMs + 30 * 86_400_000)),
    name,
    keys.publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = createSign("sha256").update(tbs).sign(keys.privateKey);
  const certificate = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const base64 = certificate.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}
