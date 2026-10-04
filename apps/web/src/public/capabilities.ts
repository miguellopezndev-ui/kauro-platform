// The capability publication as the public pages read it (design D-TOPO-2; manual 11 "Public route map"; W5b's
// GET /api/v1/public/capability-publication). The publication lists the service modes that admit real customers right now, each in an offered
// state, and the instant it was read. It is the one source for "which services are open": Home, Supported services, Pricing and Service
// status all take their availability from it and from nothing else, so no page can say a service is open that the api would refuse.
//
// Everything here is pure. The reply is read strictly (the shape the api's response schema declares and nothing else); anything else is
// UNAVAILABLE, which the pages word as "cannot be read right now" and never as "running" or "stopped".
import type { PublicCopyId } from "../copy/public.ts";
import { SERVICE_MODES, type ServiceMode } from "./policy-snapshot.ts";

/** Where the api serves the publication, on the public origin (the deployment routes /api/v1 to the api on both hosts). */
export const PUBLICATION_PATH = "/api/v1/public/capability-publication";

export type OfferedState = "AVAILABLE" | "AVAILABLE_LIMITED";

export interface PublishedMode {
  readonly mode: ServiceMode;
  readonly state: OfferedState;
  readonly version: string;
  /** The instant, in UTC, from which this version of the capability is offered. */
  readonly validFrom: string;
}

export type Publication =
  | { readonly kind: "READ"; readonly observedAt: string; readonly modes: readonly PublishedMode[] }
  | { readonly kind: "UNAVAILABLE" };

export const UNAVAILABLE: Publication = Object.freeze({ kind: "UNAVAILABLE" });

/** What a page says about one mode: it is listed (in full or with limits), it is not listed, or nothing can be said. */
export type Availability = "AVAILABLE" | "LIMITED" | "CLOSED" | "UNREAD";

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function isInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = INSTANT.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0));
  return date.getUTCFullYear() === year && date.getUTCMonth() === (month ?? 1) - 1 && date.getUTCDate() === day && (hour ?? 0) < 24 && (minute ?? 0) < 60 && (second ?? 0) < 60;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, names: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === names.length && names.every((name) => keys.includes(name));
};

function parseMode(value: unknown): PublishedMode | null {
  if (!isRecord(value) || !keysAre(value, ["capabilityId", "mode", "version", "state", "validFrom"])) return null;
  const { capabilityId, mode, version, state, validFrom } = value;
  if (typeof capabilityId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(capabilityId)) return null;
  if (typeof mode !== "string" || !(SERVICE_MODES as readonly string[]).includes(mode)) return null;
  if (state !== "AVAILABLE" && state !== "AVAILABLE_LIMITED") return null;
  if (typeof version !== "string" || version.length < 1 || version.length > 200 || CONTROL.test(version)) return null;
  if (!isInstant(validFrom)) return null;
  return { mode: mode as ServiceMode, state, version, validFrom };
}

/** The publication from the api's decoded JSON, or UNAVAILABLE when it is not exactly the published shape. */
export function parsePublication(value: unknown): Publication {
  if (!isRecord(value) || !keysAre(value, ["observedAt", "capabilities"])) return UNAVAILABLE;
  const { observedAt, capabilities } = value;
  if (!isInstant(observedAt) || !Array.isArray(capabilities) || capabilities.length > SERVICE_MODES.length) return UNAVAILABLE;
  const modes: PublishedMode[] = [];
  for (const item of capabilities) {
    const mode = parseMode(item);
    if (mode === null || modes.some((seen) => seen.mode === mode.mode)) return UNAVAILABLE;
    modes.push(mode);
  }
  modes.sort((a, b) => SERVICE_MODES.indexOf(a.mode) - SERVICE_MODES.indexOf(b.mode));
  return { kind: "READ", observedAt, modes };
}

/** The listed modes, in the order the ladder shows them (none when the publication could not be read). */
export function publishedModes(publication: Publication): readonly PublishedMode[] {
  return publication.kind === "READ" ? publication.modes : [];
}

export function availabilityOf(publication: Publication, mode: ServiceMode): Availability {
  if (publication.kind === "UNAVAILABLE") return "UNREAD";
  const listed = publication.modes.find((entry) => entry.mode === mode);
  if (listed === undefined) return "CLOSED";
  return listed.state === "AVAILABLE" ? "AVAILABLE" : "LIMITED";
}

/**
 * The sentence CLEAN's card carries about qualified destinations. A mode is named as qualified only if the publication lists it, so when
 * HubSpot is closed the sentence does not say Kauro qualifies HubSpot imports (A3 3.2: "a mode is named as qualified only if the capability
 * publication lists it as available").
 */
export function cleanQualifiesId(publication: Publication): PublicCopyId {
  if (publication.kind === "UNAVAILABLE") return "services.clean.qualifies.unknown";
  const hubspot = availabilityOf(publication, "HUBSPOT") !== "CLOSED";
  const salesforce = availabilityOf(publication, "SALESFORCE") !== "CLOSED";
  if (hubspot && salesforce) return "services.clean.qualifies.both";
  if (hubspot) return "services.clean.qualifies.hubspot";
  if (salesforce) return "services.clean.qualifies.salesforce";
  return "services.clean.qualifies.none";
}

/** An instant to the minute with its zone: "2026-10-02 09:30 UTC" (D-COPY-1). */
export function formatInstant(instant: string): string {
  if (!isInstant(instant)) throw new RangeError("not a UTC instant");
  return `${instant.slice(0, 10)} ${instant.slice(11, 16)} UTC`;
}
