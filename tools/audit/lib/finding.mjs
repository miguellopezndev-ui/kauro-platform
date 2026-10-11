// The audit finding (R2 21:95: "A finding records requirement, subject, reproduction, expected/observed result, root cause or current
// causal hypothesis, impact, affected consumers, proposed repair and acceptance cases. Distinguish demonstrated defect, blocked
// verification and optional improvement."; :97 "Material defects include unauthorized data effect, cross-tenant exposure, false payment
// authority, duplicate billable dispatch, false success, lost source units, invalid target output, hidden retention failure and
// misleading release evidence. They block the affected capability.").
// K-2a: materialClass set => kind DEFECT|BLOCKED_VERIFICATION, class M, capability non-empty. K-2b (tier, input-only): tier MUST be 1 when
// family is money|tenant|revocation, or materialClass is one of the first four, or `authority: true` (failure-matrix template rule 9);
// class D (design section 4) never for tier 1 or material. Errors: E_FINDING_FIELD (err.field), E_FINDING_KIND, E_TIER,
// E_TIER_CLASS_D, E_MATERIAL_KIND, E_MATERIAL_CLASS, E_MATERIAL_CAPABILITY.
import { FAMILIES } from "./families.mjs";
import { checkSubject, fail } from "./record.mjs";

export const KINDS = Object.freeze(["DEFECT", "BLOCKED_VERIFICATION", "IMPROVEMENT"]);
export const MATERIAL_CLASSES = Object.freeze(["unauthorized data effect", "cross-tenant exposure", "false payment authority", "duplicate billable dispatch", "false success", "lost source units", "invalid target output", "hidden retention failure", "misleading release evidence"]);
const TIER1_MATERIAL = new Set(MATERIAL_CLASSES.slice(0, 4));
const TIER1_FAMILIES = new Set(["money", "tenant", "revocation"]);
export const FINDING_FIELDS = Object.freeze(["requirement", "subject", "reproduction", "expected", "observed", "rootCause", "impact", "consumers", "repair", "acceptanceCases", "kind", "class", "dimension", "capability", "family", "tier"]);

const HEX64 = /^[0-9a-f]{64}$/;
const isText = (v) => typeof v === "string" && v.length > 0;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function bad(field, why = "is missing or has the wrong shape") {
  return fail("E_FINDING_FIELD", `finding field ${field} ${why}`, { field });
}

export function validateFinding(f) {
  if (!isObject(f)) throw bad("finding", "is not an object");
  for (const field of FINDING_FIELDS) if (f[field] === undefined) throw bad(field);
  if (!isObject(f.requirement) || !isText(f.requirement.doc) || !isText(f.requirement.heading)) throw bad("requirement");
  checkSubject(f.subject, "subject", bad);
  if (!Array.isArray(f.reproduction) || f.reproduction.length === 0 || !f.reproduction.every(isText)) throw bad("reproduction");
  if (!isText(f.expected)) throw bad("expected");
  if (!isObject(f.observed) || !isText(f.observed.text) || !isObject(f.observed.rawRef) || !isText(f.observed.rawRef.path) || !HEX64.test(f.observed.rawRef.sha256 ?? "")) throw bad("observed");
  if (!isObject(f.rootCause) || !["CAUSE", "HYPOTHESIS"].includes(f.rootCause.kind) || !isText(f.rootCause.text)) throw bad("rootCause");
  if (!isText(f.impact)) throw bad("impact");
  if (!Array.isArray(f.consumers) || !f.consumers.every(isText)) throw bad("consumers");
  if (!isText(f.repair)) throw bad("repair");
  if (!Array.isArray(f.acceptanceCases) || f.acceptanceCases.length === 0 || !f.acceptanceCases.every((c) => /^\S.* :: ".+"$/.test(c))) throw bad("acceptanceCases");
  if (!KINDS.includes(f.kind)) throw fail("E_FINDING_KIND", `kind ${JSON.stringify(f.kind)} is not ${KINDS.join(", ")}`, { field: "kind" });
  if (f.class !== "D" && f.class !== "M") throw bad("class");
  if (!isText(f.dimension)) throw bad("dimension");
  if (typeof f.capability !== "string") throw bad("capability");
  if (!FAMILIES.includes(f.family)) throw bad("family", `is not one of ${FAMILIES.join(", ")}`);
  if (![1, 2, 3].includes(f.tier)) throw bad("tier");
  if (f.materialClass !== undefined && !MATERIAL_CLASSES.includes(f.materialClass)) throw bad("materialClass", "is not one of the 9 R2 material classes");
  const mustBeTier1 = TIER1_FAMILIES.has(f.family) || TIER1_MATERIAL.has(f.materialClass) || f.authority === true;
  if (mustBeTier1 && f.tier !== 1) throw fail("E_TIER", `a ${f.authority === true ? "authority" : f.materialClass ?? f.family} finding is tier 1, not ${f.tier}`);
  if (f.materialClass !== undefined) {
    if (f.kind === "IMPROVEMENT") throw fail("E_MATERIAL_KIND", `a material finding (${f.materialClass}) is a DEFECT or BLOCKED_VERIFICATION, never an IMPROVEMENT`);
    if (f.class !== "M") throw fail("E_MATERIAL_CLASS", `a material finding (${f.materialClass}) is class M`);
    if (!isText(f.capability)) throw fail("E_MATERIAL_CAPABILITY", `a material finding (${f.materialClass}) names the capability it blocks`);
  }
  if (f.tier === 1 && f.class === "D") throw fail("E_TIER_CLASS_D", "a tier 1 finding is never class D");
  return f;
}
