// The fixed identity of the CONTRACT_FAKE bank account every bank test world is bound to, and the one place the fake evidence port is
// built (bank-support.ts bankWorld, integration-support.ts integrationWorld({ bankEvidence }), commission-support.ts
// commissionWorld({ bankEvidence })). No world is imported here, so every support module may import it.
import { createHmac } from "node:crypto";
import type { Sha256Hex } from "@kauro/contracts";
import type { DestinationFingerprinter } from "@kauro/application";
import type { BankAccountRef, DestinationFingerprintRecord, PaymentEnvironment } from "@kauro/domain";
import { createBankEvidenceFake, type BankEvidenceFake } from "@kauro/application/testing";
import { clock } from "./support.js";

export const BANK_ACCOUNT = "acct-contract-fake-1" as BankAccountRef;
export const BANK_ENVIRONMENT: PaymentEnvironment = "SANDBOX";
/** The payee digest of the fixture account: what a credit artifact must carry to be for this route. */
export const BANK_PAYEE_DIGEST: Sha256Hex = "b".repeat(64);

/** The CONTRACT_FAKE evidence port and its restricted store, bound to the fixture account (SIMULATED: never provider evidence). */
export function bankEvidenceFake(): BankEvidenceFake {
  return createBankEvidenceFake({ clock, environment: BANK_ENVIRONMENT, accountRef: BANK_ACCOUNT, payeeDigest: BANK_PAYEE_DIGEST });
}

// --- timing: the manual rail's route data (migration 0054 defaults) ---------------------------------------------------------------------

/** The manual execution window and the coverage lag of a route version (bank_route_versions.manual_execution_window_ms / coverage_lag_ms defaults). */
export const ROUTE_TIMING: Readonly<{ manualExecutionWindowMs: number; coverageLagMs: number }> = Object.freeze({ manualExecutionWindowMs: 4 * 3_600_000, coverageLagMs: 3_600_000 });

// --- the test destination fingerprinter (S3) -------------------------------------------------------------------------------------------

export const TEST_FINGERPRINT_KEY = Object.freeze({ keyId: "test-key", keyVersion: 1, normVersion: "destination-norm-v1" });
const FINGERPRINT_SECRET = "kauro-test-destination-fingerprint-secret";

/**
 * A DestinationFingerprinter for tests: HMAC-SHA256 under a fixed secret of key id 'test-key', version 1, over the canonical JSON of the
 * three fields it is GIVEN. It normalizes nothing (destination-norm-v1 is the refund lane's behaviour, applied before this port is called).
 * Another key id or version fingerprints under a derived secret, so a rotated key yields another value.
 */
export const testDestinationFingerprinter: DestinationFingerprinter = {
  current: () => TEST_FINGERPRINT_KEY,
  async fingerprint(destination, under): Promise<DestinationFingerprintRecord> {
    const secret = `${FINGERPRINT_SECRET}|${under.keyId}|${under.keyVersion}`;
    const canonical = JSON.stringify([under.normVersion, destination.routingNumber, destination.accountNumber, destination.holderName]);
    return { fingerprint: createHmac("sha256", secret).update(canonical, "utf8").digest("hex") as Sha256Hex, keyId: under.keyId, keyVersion: under.keyVersion, normVersion: under.normVersion };
  },
};
