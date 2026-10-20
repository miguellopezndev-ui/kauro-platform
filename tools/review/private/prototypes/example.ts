// The example project (Order 11): what a new account explores before it has a workspace (the owner's decision of 2026-10-20: "explore Kauro
// and an interactive example with synthetic data, without configuring an organisation"). It is the public site's own worked example, so a
// visitor who read How it works finds the same files, counts and price inside: contacts.csv and companies.xlsx, 207 duplicate candidate
// groups of which 200 were approved, prepared for HubSpot, priced by the policy's band for its billable source units. Every number is taken
// from the public sample data and the vendored policy, never typed twice. Nothing in it is anyone's data, and every page that shows it
// says so.
import { PUBLIC_COPY } from "@web/copy/public.ts";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { bandIndexOf, bandLabel, formatCount, formatUsd, priceOf } from "@web/public/pricing-bands.ts";
import { MANIFEST_FILES, SAMPLE, SAMPLE_GROUPS, SAMPLE_SOURCES } from "@web/public/sample-data.ts";

const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
const companies = MANIFEST_FILES.find((file) => file.name !== SAMPLE.contactsFile);
if (contacts === undefined || companies === undefined) throw new Error("the public sample data lost a file");

const units = contacts.source + companies.source;
const band = bandIndexOf(units);
if (band === null) throw new Error("the example's units fall outside every band");
const groups = SAMPLE_GROUPS.pairs + SAMPLE_GROUPS.triples;

export const EXAMPLE = Object.freeze({
  name: "Example project",
  client: "Larch Studio (synthetic)",
  destination: "HubSpot",
  sources: SAMPLE_SOURCES,
  contacts: contacts.source,
  companies: companies.source,
  units,
  unitsText: formatCount(units),
  band: bandLabel(band),
  price: formatUsd(priceOf(band, "HUBSPOT")),
  groups,
  approved: groups - SAMPLE_GROUPS.pairsKeptApart,
  outputs: MANIFEST_FILES.map((file) => file.name),
});

/** How long the files of a free check stay when nothing is bought, from the policy: "7 days … 14 at the latest". */
export const UNPAID_RETENTION = Object.freeze({
  days: POLICY_SNAPSHOT.retention.unpaidDaysFromReady,
  hardDays: POLICY_SNAPSHOT.retention.unpaidDaysHardFromSeal,
});

/** The six stages of a project, in How it works's own words (its stage headings), with the example's own fact for each. */
export const EXAMPLE_STAGES = [
  { key: "sources", name: PUBLIC_COPY["how.stage.files.heading"], fact: `${EXAMPLE.sources.length} files · ${EXAMPLE.unitsText} rows` },
  { key: "check", name: PUBLIC_COPY["how.stage.check.heading"], fact: `${formatCount(EXAMPLE.groups)} possible duplicate groups` },
  { key: "plan", name: PUBLIC_COPY["how.stage.decide.heading"], fact: `${formatCount(EXAMPLE.approved)} groups approved` },
  { key: "quote", name: PUBLIC_COPY["how.stage.quote.heading"], fact: `${EXAMPLE.price} · ${EXAMPLE.band.replace(/^Up/, "up")} units` },
  { key: "prepare", name: PUBLIC_COPY["how.stage.prepare.heading"], fact: "Verified" },
  { key: "deliver", name: PUBLIC_COPY["how.stage.import.heading"], fact: `${EXAMPLE.outputs.length} files, report, manifest` },
] as const;
