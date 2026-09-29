/**
 * Opaque object names (09 "Storage zones and object registry": object names use opaque identifiers and fixed safe separators; the
 * system never concatenates an original filename into a storage path; 08 "Storage capabilities": a prefix such as job-1 must not
 * accidentally include job-10). A name is the zone and two to five canonical UUIDs, so every component has a fixed length and a
 * scope prefix always ends at a separator. The database checks the same grammar (kauro.is_object_name) and that the second
 * component is the owning agency.
 */
import type { AgencyId, ProjectId, RevisionId } from "../ids.js";
import type { StorageZone } from "./records.js";
import type { SourceFileId, UploadId } from "./ids.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OBJECT_NAME = new RegExp(`^(quarantine|accepted|profile|minimized|staging|delivery|import-receipt|legal-finance|security)(/${UUID}){2,5}$`);

export function zonePrefix(zone: StorageZone): string {
  return zone.toLowerCase().replace(/_/g, "-");
}

export function isObjectName(value: unknown): value is string {
  return typeof value === "string" && OBJECT_NAME.test(value);
}

/** Quarantine destination of one upload: quarantine/<agency>/<project>/<revision>/<upload>. */
export function quarantineObjectName(agencyId: AgencyId, projectId: ProjectId, revisionId: RevisionId, uploadId: UploadId): string {
  return `quarantine/${agencyId}/${projectId}/${revisionId}/${uploadId}`;
}

/** Accepted generation of one admitted file: accepted/<agency>/<project>/<file>. */
export function acceptedObjectName(agencyId: AgencyId, projectId: ProjectId, fileId: SourceFileId): string {
  return `accepted/${agencyId}/${projectId}/${fileId}`;
}

/** The listing prefix of one agency in one zone (ends with the separator: no other agency can match it). */
export function agencyPrefix(zone: StorageZone, agencyId: AgencyId): string {
  return `${zonePrefix(zone)}/${agencyId}/`;
}
