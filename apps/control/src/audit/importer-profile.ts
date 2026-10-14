/**
 * The importer-profile gate of PLAN_VALIDATION (package B17 L2, plan docs/design/B15-B17-B18-local-plan.md cell M3; R2 05 "Importer
 * profiles": 05:27 the instance is part of every target reference, 05:43 multi-select replacement and append are separate primitives,
 * 05:75 relationship depth, 05:91 and 05:93 null markers and clear, "a secondary contact email combined with Record ID").
 *
 * Pure: the plan's body and the target body it was validated against in, a reason out. It runs inside PlanValidator.run before the core
 * is called and writes nothing (RACE, CRASH and PARTIAL are N/A; the refusal is one settle statement, receipts.ts and the consumers).
 * The catalogue is closed and keyed by `(importerProfileId uuid, importerVersion)` (ADV-19; target_contracts.importer_profile_id): a pair
 * it does not hold, or one of another mode, is IMPORTER_PROFILE_UNKNOWN. The gate applies to HUBSPOT and SALESFORCE targets; a CLEAN
 * target has no importer, so it is vacuous there.
 *
 * Predicates are input-only and evaluated in a fixed order. R2-019 precedes R2-018 because the combination it names contains a native
 * Record ID write, which R2-018 alone would refuse first.
 */
import type { PlanBody, TargetBody } from "@kauro/domain";

export const IMPORTER_PROFILE_REASONS = Object.freeze({
  UNKNOWN: "IMPORTER_PROFILE_UNKNOWN",
  NATIVE_ID_UNVALIDATED: "IMPORTER_PROFILE_NATIVE_ID_UNVALIDATED",
  SECONDARY_EMAIL_WITH_RECORD_ID: "IMPORTER_PROFILE_SECONDARY_EMAIL_WITH_RECORD_ID",
  REPLACEMENT_UNQUALIFIED: "IMPORTER_PROFILE_REPLACEMENT_UNQUALIFIED",
  RELATIONSHIP_DEPTH: "IMPORTER_PROFILE_RELATIONSHIP_DEPTH",
  NULL_MARKER_COLLISION: "IMPORTER_PROFILE_NULL_MARKER_COLLISION",
} as const);
export type ImporterProfileReason = (typeof IMPORTER_PROFILE_REASONS)[keyof typeof IMPORTER_PROFILE_REASONS];

/** A tool and operation profile of the closed catalogue (the fields the gate reads). */
export interface ImporterProfile {
  readonly name: string;
  readonly mode: "HUBSPOT" | "SALESFORCE";
  readonly tool: string;
  /** The field that carries the CRM's own record id on a write. */
  readonly recordIdField: string;
  /** Per object API name, the fields a secondary contact email travels in. */
  readonly secondaryEmailFields: Readonly<Record<string, ReadonlyArray<string>>>;
  /** The most relationship hops a reference may traverse. */
  readonly maxRelationshipDepth: number;
  /** A literal token the importer reads as "clear this value", or null when it reads none. */
  readonly nullMarker: string | null;
  /** What an association field's write does to existing links: exactly ["ADD"] is add-only. */
  readonly associationEffects: ReadonlyArray<string>;
  /** The same for a multi-value enumeration. */
  readonly multiEnumEffects: ReadonlyArray<string>;
}

/** The observed tool/API contract version every catalogue profile is qualified for. */
export const IMPORTER_VERSION = "R2-INITIAL";

/** The uuids of the catalogue (the tests carry their own copy of these keys: a drifting key fails there, not here). */
export const IMPORTER_PROFILE_IDS = Object.freeze({
  HUBSPOT_IMPORT_UI: "0192a000-0000-7000-8000-000000000001",
  SALESFORCE_DATA_LOADER: "0192a000-0000-7000-8000-000000000002",
  SF_BULK_API2: "0192a000-0000-7000-8000-000000000003",
});

const PROFILES: ReadonlyMap<string, ImporterProfile> = new Map<string, ImporterProfile>([
  [
    `${IMPORTER_PROFILE_IDS.HUBSPOT_IMPORT_UI}@${IMPORTER_VERSION}`,
    {
      name: "HUBSPOT_IMPORT_UI",
      mode: "HUBSPOT",
      tool: "HUBSPOT_IMPORT_UI",
      recordIdField: "hs_object_id",
      secondaryEmailFields: { contacts: ["hs_additional_emails"] },
      maxRelationshipDepth: 1,
      nullMarker: null,
      associationEffects: ["ADD"],
      multiEnumEffects: ["ADD"],
    },
  ],
  [
    `${IMPORTER_PROFILE_IDS.SALESFORCE_DATA_LOADER}@${IMPORTER_VERSION}`,
    {
      name: "SALESFORCE_DATA_LOADER",
      mode: "SALESFORCE",
      tool: "SALESFORCE_DATA_LOADER",
      recordIdField: "Id",
      secondaryEmailFields: {},
      maxRelationshipDepth: 1,
      nullMarker: null,
      associationEffects: ["ADD"],
      multiEnumEffects: ["ADD"],
    },
  ],
  [
    // not offered to agencies; it is in the catalogue because it is the one importer whose clear token is a literal ("#N/A")
    `${IMPORTER_PROFILE_IDS.SF_BULK_API2}@${IMPORTER_VERSION}`,
    {
      name: "SF_BULK_API2",
      mode: "SALESFORCE",
      tool: "SF_BULK_API2",
      recordIdField: "Id",
      secondaryEmailFields: {},
      maxRelationshipDepth: 1,
      nullMarker: "#N/A",
      associationEffects: ["ADD"],
      multiEnumEffects: ["ADD"],
    },
  ],
]);

/** The catalogue's profile of a pair, or none. */
export function importerProfileOf(importerProfileId: string, importerVersion: string): ImporterProfile | null {
  return PROFILES.get(`${importerProfileId}@${importerVersion}`) ?? null;
}

const WRITES = new Set(["SET", "KEEP", "CLEAR"]);
const HOP = /[.:]/g;

function hops(name: string): number {
  return (name.match(HOP) ?? []).length;
}

/**
 * The first importer-profile reason that refuses `body` on `target`, or null when the profile can carry it. A native-ID validation
 * receipt bound to the target instance is the one thing that clears R2-018; nothing produces one yet (D-11), so every plan with a native
 * identity is refused.
 */
export function importerProfileRefusal(body: PlanBody, target: TargetBody, nativeIdValidatedInstances: ReadonlySet<string> = new Set()): ImporterProfileReason | null {
  if (target.mode === "CLEAN") return null;
  const profile = importerProfileOf(target.importerProfileId, target.importerVersion);
  if (profile === null || profile.mode !== target.mode) return IMPORTER_PROFILE_REASONS.UNKNOWN;
  const typeOf = (object: string, field: string): string | undefined => target.objects.find((o) => o.apiName === object)?.fields.find((f) => f.apiName === field)?.dataType;
  const writes = body.mappings.filter((m) => WRITES.has(m.intent.kind));

  // R2-019: Record ID and a secondary email of one object
  const withRecordId = new Set(writes.filter((m) => m.targetField === profile.recordIdField).map((m) => m.targetObject));
  for (const m of writes) {
    if (withRecordId.has(m.targetObject) && (profile.secondaryEmailFields[m.targetObject] ?? []).includes(m.targetField)) return IMPORTER_PROFILE_REASONS.SECONDARY_EMAIL_WITH_RECORD_ID;
  }
  // R2-021: no more hops than the profile qualifies, in a target field or a relationship
  if (writes.some((m) => hops(m.targetField) > profile.maxRelationshipDepth) || body.relationships.some((r) => hops(r.relationType) > profile.maxRelationshipDepth)) {
    return IMPORTER_PROFILE_REASONS.RELATIONSHIP_DEPTH;
  }
  // R2-022: a literal null marker collides with a TEXT write and with every clear
  if (profile.nullMarker !== null && writes.some((m) => m.intent.kind === "CLEAR" || ((m.intent.kind === "SET" || m.intent.kind === "KEEP") && typeOf(m.targetObject, m.targetField) === "TEXT"))) {
    return IMPORTER_PROFILE_REASONS.NULL_MARKER_COLLISION;
  }
  // R2-020: a replacing intent on a multi-value or association field when the profile only adds
  const addOnly = (effects: ReadonlyArray<string>): boolean => effects.length === 1 && effects[0] === "ADD";
  for (const m of writes) {
    if (m.intent.kind !== "SET" && m.intent.kind !== "CLEAR") continue;
    const type = typeOf(m.targetObject, m.targetField);
    if ((type === "MULTI_ENUM" && addOnly(profile.multiEnumEffects)) || (type === "REFERENCE" && addOnly(profile.associationEffects))) return IMPORTER_PROFILE_REASONS.REPLACEMENT_UNQUALIFIED;
  }
  // R2-018: a native identity needs the instance's native-ID validation receipt
  if (!nativeIdValidatedInstances.has(target.instanceId) && (body.relationships.some((r) => r.resolution === "TARGET_NATIVE_ID") || withRecordId.size > 0)) {
    return IMPORTER_PROFILE_REASONS.NATIVE_ID_UNVALIDATED;
  }
  return null;
}
