/**
 * Contract fakes of the evidence store, the fiscal bridge and the service authenticator (decision D-FAKE-B1; evidence class
 * SIMULATED; never counted as integration — the real adapters are package B15's):
 *
 *  - ProviderEvidenceStore — the restricted reconciliation store (10 "Raw sensitive provider responses stay in a restricted
 *    reconciliation store"): immutable and content-addressed — the same bytes always answer the same reference (a UUIDv8 of their
 *    SHA-256), a second put of them never replaces what was stored, and what `get` returns is a frozen copy;
 *  - FiscalDocumentBridge — `prepare` only (the local boundary of package B09, R2-128): the issuance packet of a VALIDATED document
 *    from its reviewed treatment and nothing an exemption could be inferred from; `submit` and `observe` belong to the issuance
 *    command (CMD035, package B15) and are refused here;
 *  - ServiceAuthenticator — a compact signed token standing in for the Google OIDC verifier (10 "Internal command authentication":
 *    issuer, audience, expected service identity and environment, expiry).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import type { Clock, ServiceIdentity } from "@kauro/domain";
import type { FiscalDocumentBridge, FiscalIssuancePacket, ProviderEvidenceStore, ServiceAuthenticator, StoredEvidence } from "../ports.js";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, sha256Hex, uuidV8Of, type FakeCall } from "./labels.js";

// --- evidence store ------------------------------------------------------------------------------------------------------------

export interface EvidenceStoreFake extends ProviderEvidenceStore {
  readonly integrationClass: typeof CONTRACT_FAKE;
  readonly evidenceClass: typeof FAKE_EVIDENCE_CLASS;
  readonly calls: ReadonlyArray<FakeCall>;
  /** The exact bytes stored under a reference (test inspection; a restricted store never serves them to a tenant). */
  bytesOf(artifactRef: string): Uint8Array | null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export function createEvidenceStoreFake(options: { readonly clock: Clock }): EvidenceStoreFake {
  const stored = new Map<string, { readonly evidence: StoredEvidence; readonly bytes: Uint8Array }>();
  const calls: FakeCall[] = [];
  return {
    integrationClass: CONTRACT_FAKE,
    evidenceClass: FAKE_EVIDENCE_CLASS,
    get calls() {
      return calls;
    },
    async put(evidence) {
      const sha256 = sha256Hex(evidence.bytes);
      const artifactRef = uuidV8Of(sha256);
      calls.push(Object.freeze({ port: "ProviderEvidenceStore", operation: "PUT", identity: artifactRef, at: options.clock.now(), sent: true }));
      if (!stored.has(artifactRef)) {
        const { bytes, ...meta } = evidence;
        stored.set(artifactRef, { evidence: deepFreeze(structuredClone({ ...meta, artifactRef, sha256 })), bytes: Uint8Array.from(bytes) });
      }
      return { artifactRef, sha256 };
    },
    async get(artifactRef) {
      calls.push(Object.freeze({ port: "ProviderEvidenceStore", operation: "GET", identity: artifactRef, at: options.clock.now(), sent: true }));
      return stored.get(artifactRef)?.evidence ?? null;
    },
    async findByDigest(sha256) {
      // content-addressed: the reference is a function of the digest (stage-2 mandate M3, decision D-M3-B2)
      calls.push(Object.freeze({ port: "ProviderEvidenceStore", operation: "FIND_BY_DIGEST", identity: sha256, at: options.clock.now(), sent: true }));
      return stored.get(uuidV8Of(sha256))?.evidence ?? null;
    },
    bytesOf(artifactRef) {
      const s = stored.get(artifactRef);
      return s === undefined ? null : Uint8Array.from(s.bytes);
    },
  };
}

// --- fiscal bridge (prepare only) ----------------------------------------------------------------------------------------------

export const FISCAL_ISSUANCE_DOMAIN = "KAURO_FISCAL_ISSUANCE_REQUEST_V1";

export interface FiscalBridgeFake extends FiscalDocumentBridge {
  readonly integrationClass: typeof CONTRACT_FAKE;
  readonly evidenceClass: typeof FAKE_EVIDENCE_CLASS;
}

export function createFiscalBridgeFake(options: { readonly routeKind?: "PROVIDER_API" | "MANUAL_BRIDGE" } = {}): FiscalBridgeFake {
  return {
    routeKind: options.routeKind ?? "PROVIDER_API",
    integrationClass: CONTRACT_FAKE,
    evidenceClass: FAKE_EVIDENCE_CLASS,
    prepare(document, context): FiscalIssuancePacket {
      // only a validated document with a reviewed treatment is issued (R2-082, R2-128): nothing here can infer an exemption
      if (document.state !== "VALIDATED" || document.blockedReason !== undefined) throw new RangeError("only a VALIDATED, unblocked document is prepared for issuance");
      if (document.taxTreatment === "REVIEW_REQUIRED" || context.profile.taxTreatment !== document.taxTreatment || context.profile.profileId !== document.fiscalProfileId) {
        throw new RangeError("the issuance packet carries exactly the document's reviewed fiscal snapshot");
      }
      if (context.issuer.issuerRef !== document.issuerRef) throw new RangeError("the issuer is the document's own");
      if (document.kind === "CREDIT_NOTE" && (context.original === undefined || context.original.legalNumber === undefined)) throw new RangeError("a credit note corrects an issued invoice with its legal number");
      const correctsLegalNumber = document.kind === "CREDIT_NOTE" ? context.original?.legalNumber : undefined;
      const preimage = {
        documentId: document.documentId,
        kind: document.kind,
        issuerRef: document.issuerRef,
        fiscalProfileId: document.fiscalProfileId,
        treatment: document.taxTreatment,
        rule: context.profile.taxRule,
        rateBps: context.profile.taxRateBps,
        serviceCents: document.serviceCents.toString(),
        taxCents: document.taxCents.toString(),
        currency: document.currency,
        ...(correctsLegalNumber !== undefined ? { correctsLegalNumber } : {}),
      };
      const issueRequestHash: Sha256Hex = rawDigest(canonicalBytes({ domain: FISCAL_ISSUANCE_DOMAIN, version: 1, payload: preimage }));
      return {
        documentId: document.documentId,
        issueRequestHash,
        kind: document.kind,
        treatment: document.taxTreatment,
        serviceCents: document.serviceCents,
        taxCents: document.taxCents,
        currency: document.currency,
        ...(correctsLegalNumber !== undefined ? { correctsLegalNumber } : {}),
      };
    },
    async submit() {
      throw new Error("fiscal issuance is the command CMD035 of the integration package B15; the contract fake of B09 prepares only");
    },
    async observe() {
      throw new Error("fiscal issuance is the command CMD035 of the integration package B15; the contract fake of B09 prepares only");
    },
  };
}

// --- service authenticator -------------------------------------------------------------------------------------------------------

export interface ServiceAuthenticatorFake extends ServiceAuthenticator {
  readonly integrationClass: typeof CONTRACT_FAKE;
  readonly evidenceClass: typeof FAKE_EVIDENCE_CLASS;
  readonly calls: ReadonlyArray<FakeCall>;
  /** A bearer token for a service identity, as the identity provider would mint it (tests only). */
  mint(identity: ServiceIdentity, options?: { readonly issuer?: string; readonly expiresAt?: UtcInstant; readonly secret?: string }): string;
}

export interface ServiceAuthenticatorFakeOptions {
  readonly clock: Clock;
  /** The issuer this deployment trusts and the audience of its service routes (10 "Internal command authentication"). */
  readonly issuer?: string;
  readonly audience?: string;
  readonly secret?: string;
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

export function createServiceAuthenticatorFake(options: ServiceAuthenticatorFakeOptions): ServiceAuthenticatorFake {
  const issuer = options.issuer ?? "https://oidc.contract-fake.kauro.test";
  const audience = options.audience ?? "kauro-api";
  const secret = options.secret ?? "contract-fake-oidc-signing-secret";
  const calls: FakeCall[] = [];
  const sign = (payload: string, key: string): string => createHmac("sha256", key).update(payload).digest("base64url");
  return {
    integrationClass: CONTRACT_FAKE,
    evidenceClass: FAKE_EVIDENCE_CLASS,
    get calls() {
      return calls;
    },
    async authenticate(headers) {
      const header = headers["authorization"];
      calls.push(Object.freeze({ port: "ServiceAuthenticator", operation: "AUTHENTICATE", identity: null, at: options.clock.now(), sent: true }));
      if (header === undefined || !header.startsWith("Bearer ")) return null;
      const [payload, signature, extra] = header.slice("Bearer ".length).split(".");
      if (payload === undefined || signature === undefined || extra !== undefined) return null;
      const expected = Buffer.from(sign(payload, secret));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      let claims: Record<string, unknown>;
      try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
      const exp = typeof claims["exp"] === "string" ? Date.parse(claims["exp"]) : Number.NaN;
      if (claims["iss"] !== issuer || claims["aud"] !== audience || !Number.isFinite(exp) || exp <= options.clock.nowMs()) return null;
      const serviceId = claims["sub"];
      const environment = claims["env"];
      if (typeof serviceId !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(serviceId) || (environment !== "LOCAL" && environment !== "SANDBOX" && environment !== "LIVE")) return null;
      return { serviceId, audience, environment };
    },
    mint(identity, opts = {}) {
      const payload = b64(JSON.stringify({ iss: opts.issuer ?? issuer, aud: identity.audience, sub: identity.serviceId, env: identity.environment, exp: opts.expiresAt ?? new Date(options.clock.nowMs() + 300_000).toISOString() }));
      return `Bearer ${payload}.${sign(payload, opts.secret ?? secret)}`;
    },
  };
}
