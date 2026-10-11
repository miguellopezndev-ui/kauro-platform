/**
 * S047 (B05 C03/C04, MC half): MC-native identities are recomputed only by MC's own loaders and differ from the platform's
 * structural digest of the same document, so they can only be stored verbatim. The sealed values are the ones
 * intelligence-core/test/canonical-interop.test.ts cites as strings.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalize } from "@kauro/contracts";
import {
  buildCandidateSet,
  buildSourceProfile,
  createFilesystemScratchStore,
  hashCandidateSet,
  hashSourceProfile,
  loadCandidateSet,
  loadSourceProfile,
  serializeCandidateSet,
  serializeSourceProfile,
  syntheticConfig,
} from "../src/index.js";

const SEALED_PROFILE_HASH = "e0b5e8a44d3608b6c85deef74d9b7f2cb72ad7971a7ae452b13c65c633b78d4e";
const SEALED_CANDIDATE_SET_HASH = "bb244418fb428de27356f65e7fd4cac6949b3762f7baad2572a96190e810b522";

test("C03 S047 OK (MC half): a Unicode and large-integer profile and candidate set hash to the sealed MC-native values, reproduced only by MC loaders, and the platform digest of the same document is a different number", () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-c03-"));
  try {
    const input = join(root, "input");
    mkdirSync(input);
    writeFileSync(join(input, "clients.csv"), "id,café,café,\u{1F600}\n9007199254740993,a,b,c\n123456789012345678901234567890,d,e,f\n", "utf8");
    const scratch = createFilesystemScratchStore({ root: join(root, "scratch"), runId: "c03", quotaBytes: 64 * 1024 * 1024 });
    try {
      const profile = buildSourceProfile({ inputRoot: input, config: syntheticConfig([{ path: "clients.csv", format: "CSV" }]), scratch });
      const candidates = buildCandidateSet({ profile, configHash: "0".repeat(64) });
      assert.equal(profile.profileHash, SEALED_PROFILE_HASH);
      assert.equal(candidates.candidateSetHash, SEALED_CANDIDATE_SET_HASH);
      const loadedProfile = loadSourceProfile(serializeSourceProfile(profile), "c03 profile");
      assert.equal(loadedProfile.profileHash, SEALED_PROFILE_HASH);
      assert.equal(hashSourceProfile(loadedProfile.profile), SEALED_PROFILE_HASH);
      const loadedCandidates = loadCandidateSet(serializeCandidateSet(candidates), "c03 candidates");
      assert.equal(loadedCandidates.candidateSetHash, SEALED_CANDIDATE_SET_HASH);
      assert.equal(hashCandidateSet(loadedCandidates.candidateSet), SEALED_CANDIDATE_SET_HASH);
      // C04 (MC half): the platform profile over the same document is another number: a core-native identity is never re-hashable
      const platform = createHash("sha256").update(canonicalize(JSON.parse(JSON.stringify(profile.profile))), "utf8").digest("hex");
      assert.notEqual(platform, SEALED_PROFILE_HASH);
    } finally {
      scratch.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
