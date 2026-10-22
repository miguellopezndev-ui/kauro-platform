// The reconciliation of a world (master plan §2.1): pure functions that re-derive every count, amount and date of a World from its own
// records and the policy, and list what disagrees. An empty list means the world is consistent. It runs on the canonical world and on
// every stress variant (tools/test/canon.test.mjs), and is what a build runs before any surface renders: a screen or a document that
// reads the world can then only disagree with another by reading it wrongly, never because the data disagree.
import { bogotaDay, dayPlus, earliest, ms, nextMonth, nthBusinessDay, plusBusinessDays, plusDays, plusHours } from "./calendar.ts";
import { sellerFigures } from "./figures.ts";
import { bandIndexOf, COMMISSION, ofBps, POLICY_SNAPSHOT, priceOf, PROPOSED, repeatPercent } from "./policy.ts";
import { type Matters, type ObjectKind, type Project, type Role, STEPS, type Step, type World } from "./types.ts";

const R = POLICY_SNAPSHOT.retention;
const sum = (values: readonly number[]): number => values.reduce((total, one) => total + one, 0);
const stepIndex = (step: Step): number => STEPS.indexOf(step);
const reached = (project: Project, step: Step): boolean => stepIndex(project.step) >= stepIndex(step);

type Problems = string[];

// ---- ids and references ------------------------------------------------------------------------------------------------------------------

/** Every id is unique across the whole world, and every reference names a record that exists. */
export function checkReferences(world: World): readonly string[] {
  const problems: Problems = [];
  const all: [string, string][] = [
    ["owner", world.owner.id],
    ...world.people.map((one): [string, string] => ["person", one.id]),
    ...world.workspaces.map((one): [string, string] => ["workspace", one.id]),
    ...world.clients.map((one): [string, string] => ["client", one.id]),
    ...world.projects.map((one): [string, string] => ["project", one.id]),
    ...world.quotes.map((one): [string, string] => ["quote", one.id]),
    ...world.orders.map((one): [string, string] => ["order", one.id]),
    ...world.holds.map((one): [string, string] => ["hold", one.id]),
    ...world.payments.map((one): [string, string] => ["payment", one.id]),
    ...world.refunds.map((one): [string, string] => ["refund", one.id]),
    ...world.refundClaims.map((one): [string, string] => ["refund claim", one.id]),
    ...world.sellers.map((one): [string, string] => ["seller", one.id]),
    ...world.claims.map((one): [string, string] => ["claim", one.id]),
    ...world.prospects.map((one): [string, string] => ["prospect", one.id]),
    ...world.commissionLines.map((one): [string, string] => ["commission line", one.id]),
    ...world.retainerLines.map((one): [string, string] => ["retainer line", one.id]),
    ...world.offsets.map((one): [string, string] => ["offset", one.id]),
    ...world.statements.map((one): [string, string] => ["statement", one.id]),
    ...world.payouts.map((one): [string, string] => ["payout", one.id]),
    ...world.jobs.map((one): [string, string] => ["job", one.id]),
    ...world.incidents.map((one): [string, string] => ["incident", one.id]),
    ...world.deletions.map((one): [string, string] => ["deletion", one.id]),
    ...world.releases.map((one): [string, string] => ["release", one.id]),
    ...world.supportCases.map((one): [string, string] => ["support case", one.id]),
  ];
  const seen = new Map<string, string>();
  for (const [kind, id] of all) {
    const before = seen.get(id);
    if (before !== undefined) problems.push(`id ${id} is used by a ${before} and a ${kind}`);
    seen.set(id, kind);
  }
  const ids = (list: readonly { readonly id: string }[]): ReadonlySet<string> => new Set(list.map((one) => one.id));
  const people = ids(world.people);
  const workspaces = ids(world.workspaces);
  const projects = ids(world.projects);
  const sellers = ids(world.sellers);
  const claims = ids(world.claims);
  const statements = ids(world.statements);
  const payments = ids(world.payments);
  const supportCases = ids(world.supportCases);
  const need = (set: ReadonlySet<string>, id: string | null, what: string): void => {
    if (id !== null && !set.has(id)) problems.push(`${what} names ${id}, which does not exist`);
  };
  for (const one of world.memberships) {
    need(people, one.personId, "a membership");
    need(workspaces, one.workspaceId, "a membership");
  }
  for (const one of world.workspaces) {
    need(sellers, one.acquiredBySellerId, `workspace ${one.name}`);
    need(sellers, one.servedBySellerId, `workspace ${one.name}`);
    need(claims, one.claimId, `workspace ${one.name}`);
  }
  for (const one of world.clients) need(workspaces, one.workspaceId, `client ${one.name}`);
  for (const one of world.projects) {
    need(workspaces, one.workspaceId, `project ${one.name}`);
    const client = world.clients.find((candidate) => candidate.id === one.clientId);
    if (client === undefined) problems.push(`project ${one.name} names client ${one.clientId}, which does not exist`);
    else if (client.workspaceId !== one.workspaceId) problems.push(`project ${one.name}'s client belongs to another workspace`);
  }
  for (const one of world.quotes) need(projects, one.projectId, `quote ${one.number}`);
  for (const one of world.orders) {
    need(ids(world.quotes), one.quoteId, `order ${one.reference}`);
    const quote = world.quotes.find((candidate) => candidate.id === one.quoteId);
    if (quote !== undefined && quote.projectId !== one.projectId) problems.push(`order ${one.reference} and its quote name different projects`);
  }
  for (const one of world.holds) {
    need(ids(world.orders), one.orderId, `hold ${one.id}`);
    need(people, one.givenBy, `hold ${one.id}`);
  }
  for (const one of world.payments) {
    need(ids(world.orders), one.orderId, `payment ${one.id}`);
    need(projects, one.projectId, `payment ${one.id}`);
    need(workspaces, one.workspaceId, `payment ${one.id}`);
  }
  for (const one of world.refunds) {
    need(payments, one.paymentId, `refund ${one.id}`);
    need(supportCases, one.supportCaseId, `refund ${one.id}`);
  }
  for (const one of world.refundClaims) {
    need(payments, one.paymentId, `refund request ${one.id}`);
    need(people, one.requestedBy, `refund request ${one.id}`);
  }
  for (const one of world.claims) {
    need(sellers, one.sellerId, `claim ${one.id}`);
    need(workspaces, one.workspaceId, `claim ${one.id}`);
  }
  for (const one of world.prospects) {
    need(sellers, one.sellerId, `prospect ${one.name}`);
    need(claims, one.claimId, `prospect ${one.name}`);
    const claim = world.claims.find((candidate) => candidate.id === one.claimId);
    if (claim !== undefined && claim.sellerId !== one.sellerId) problems.push(`prospect ${one.name}'s claim belongs to another seller`);
  }
  for (const one of world.commissionLines) {
    need(sellers, one.sellerId, `line ${one.id}`);
    need(workspaces, one.workspaceId, `line ${one.id}`);
    need(projects, one.projectId, `line ${one.id}`);
    need(payments, one.paymentId, `line ${one.id}`);
    need(statements, one.statementId, `line ${one.id}`);
    if (one.hold !== null) need(supportCases, one.hold.supportCaseId, `line ${one.id}`);
  }
  for (const one of world.retainerLines) {
    need(sellers, one.sellerId, `retainer ${one.id}`);
    need(statements, one.statementId, `retainer ${one.id}`);
  }
  for (const one of world.offsets) {
    need(sellers, one.sellerId, `offset ${one.id}`);
    need(ids(world.refunds), one.refundId, `offset ${one.id}`);
    need(ids(world.commissionLines), one.adjustsLineId, `offset ${one.id}`);
    need(statements, one.statementId, `offset ${one.id}`);
  }
  for (const one of world.statements) need(sellers, one.sellerId, `statement ${one.id}`);
  for (const one of world.payouts) {
    need(sellers, one.sellerId, `payout ${one.id}`);
    need(statements, one.statementId, `payout ${one.id}`);
  }
  for (const one of world.jobs) need(projects, one.projectId, `job ${one.id}`);
  for (const one of world.incidents) for (const projectId of one.projectIds) need(projects, projectId, `incident ${one.id}`);
  for (const one of world.deletions) {
    need(projects, one.projectId, `deletion ${one.id}`);
    need(people, one.requestedBy, `deletion ${one.id}`);
  }
  for (const one of world.supportCases) {
    need(workspaces, one.workspaceId, `support case ${one.number}`);
    need(projects, one.projectId, `support case ${one.number}`);
    need(people, one.openedBy, `support case ${one.number}`);
    const project = world.projects.find((candidate) => candidate.id === one.projectId);
    if (project !== undefined && project.workspaceId !== one.workspaceId) problems.push(`support case ${one.number}'s project belongs to another workspace`);
  }
  return problems;
}

// ---- people and roles --------------------------------------------------------------------------------------------------------------------

const roleOf = (world: World, personId: string, workspaceId: string): Role | null =>
  world.memberships.find((one) => one.personId === personId && one.workspaceId === workspaceId && one.state === "ACTIVE")?.role ?? null;

export function checkPeople(world: World): readonly string[] {
  const problems: Problems = [];
  const pairs = new Set<string>();
  for (const one of world.memberships) {
    const key = `${one.personId}/${one.workspaceId}`;
    if (pairs.has(key)) problems.push(`a person holds two memberships in one workspace (${key})`);
    pairs.add(key);
  }
  for (const workspace of world.workspaces) {
    if (workspace.kind === "EXAMPLE") continue;
    if (!world.memberships.some((one) => one.workspaceId === workspace.id && one.role === "OWNER" && one.state === "ACTIVE")) problems.push(`workspace ${workspace.name} has no active owner`);
    if ((workspace.state === "RESTRICTED") !== (workspace.restriction !== null)) problems.push(`workspace ${workspace.name}: a restriction is stated exactly when it is restricted`);
    if (workspace.taxRateBps !== (workspace.country === "CO" ? 1900 : 0)) problems.push(`workspace ${workspace.name}: tax is IVA 19% for a Colombian buyer and none for an export`);
    if (workspace.kind === "COMPANY" && !world.clients.some((one) => one.workspaceId === workspace.id && one.self)) problems.push(`company ${workspace.name} has no client for itself`);
    if (ms(workspace.createdAt) > ms(world.asOf)) problems.push(`workspace ${workspace.name} is created after the world's now`);
  }
  return problems;
}

// ---- projects: counts ------------------------------------------------------------------------------------------------------------------

/** Rows of the selected sources of one object. */
const sourceRows = (project: Project, object: ObjectKind): number => sum(project.sources.filter((one) => one.selected && one.object === object).map((one) => one.rows ?? 0));
const unifiedOf = (project: Project, object: ObjectKind): number => project.duplicates.find((one) => one.object === object)?.unifiedRows ?? 0;

/** Units are the rows of the sealed, selected files; delivered rows are source rows less unified rows; unified rows come from the groups. */
export function checkCounts(world: World): readonly string[] {
  const problems: Problems = [];
  for (const project of world.projects) {
    const name = `project ${project.name} (${project.id.slice(-4)})`;
    const sealed = project.dates.sealedAt !== null;
    if (sealed !== reached(project, "TARGET")) problems.push(`${name}: sealed exactly from the TARGET step on`);
    if (!sealed && project.units !== null) problems.push(`${name}: no units before sealing`);
    if (sealed) {
      if (project.sources.some((one) => one.selected && one.rows === null)) problems.push(`${name}: a sealed file has no row count`);
      const units = sum(project.sources.filter((one) => one.selected).map((one) => one.rows ?? 0));
      if (project.units !== units) problems.push(`${name}: units ${project.units} are not the sealed rows ${units}`);
    }
    for (const result of project.duplicates) {
      const groups = result.groups;
      if (groups === null) continue;
      if (groups.keptApartPairs > groups.pairs || groups.keptApartTriples > groups.triples) problems.push(`${name}: more groups kept apart than found`);
      if (groups.demonstrated !== null && groups.demonstrated > groups.pairs + groups.triples) problems.push(`${name}: more demonstrated groups than groups`);
      const expected = groups.decided ? groups.pairs - groups.keptApartPairs + 2 * (groups.triples - groups.keptApartTriples) : null;
      if (result.unifiedRows !== expected) problems.push(`${name}: ${result.object} unified rows ${result.unifiedRows} are not approved pairs plus two per approved triple (${expected})`);
      if (2 * groups.pairs + 3 * groups.triples > sourceRows(project, result.object)) problems.push(`${name}: more ${result.object} in groups than rows`);
    }
    if (project.relationships !== null) {
      const { child, linked, unlinked } = project.relationships;
      const rows = sourceRows(project, child) - unifiedOf(project, child);
      if (linked + unlinked !== rows) problems.push(`${name}: linked ${linked} + unlinked ${unlinked} are not the ${child} rows after unification (${rows})`);
    }
    for (const output of project.outputs) {
      const rows = sourceRows(project, output.object);
      if (output.sourceRows !== rows) problems.push(`${name}: ${output.name} names ${output.sourceRows} source rows, the sources hold ${rows}`);
      if (output.unifiedRows !== unifiedOf(project, output.object)) problems.push(`${name}: ${output.name} unified rows differ from the plan`);
      if (output.rows !== output.sourceRows - output.unifiedRows) problems.push(`${name}: ${output.name} rows ${output.rows} are not source ${output.sourceRows} less unified ${output.unifiedRows}`);
    }
    if (project.mapping !== null && project.mapping.mapped > project.mapping.columns) problems.push(`${name}: more columns mapped than exist`);
    if (project.service === "CLEAN" && project.importStages.length > 0) problems.push(`${name}: Clean your data has no import`);
    for (const stage of project.importStages) {
      const output = project.outputs.find((one) => one.object === stage.object);
      if (output === undefined || output.rows !== stage.rows) problems.push(`${name}: import stage ${stage.order} rows are not the delivered ${stage.object} rows`);
      if (stage.state === "WAITING") {
        if (stage.succeeded !== null || stage.failed !== null || stage.returnedAt !== null) problems.push(`${name}: a waiting import stage has no result`);
        continue;
      }
      if (stage.succeeded === null || stage.failed === null || stage.returnedAt === null) {
        problems.push(`${name}: a returned import stage states its result`);
        continue;
      }
      if (stage.succeeded + stage.failed !== stage.rows) problems.push(`${name}: import stage ${stage.order} accepted plus refused rows are not its rows`);
      const shape = stage.state === "SUCCEEDED" ? stage.failed === 0 : stage.state === "FAILED" ? stage.succeeded === 0 : stage.failed > 0 && stage.succeeded > 0;
      if (!shape) problems.push(`${name}: import stage ${stage.order} is ${stage.state} with ${stage.succeeded} accepted and ${stage.failed} refused`);
    }
  }
  return problems;
}

// ---- projects: steps, dates and the date that matters -------------------------------------------------------------------------------------

/** The files of an unpaid project: 7 days after its check is ready, never past 14 days from sealing (or 14 days from sealing without a check). */
function unpaidFilesEnd(project: Project): string | null {
  const { sealedAt, checkReadyAt } = project.dates;
  if (sealedAt === null) return null;
  const hard = plusDays(sealedAt, R.unpaidDaysHardFromSeal);
  return checkReadyAt === null ? hard : earliest(plusDays(checkReadyAt, R.unpaidDaysFromReady), hard);
}

export function expectedMatters(world: World, project: Project): Matters | null {
  if (project.example) return null;
  const quote = world.quotes.find((one) => one.projectId === project.id && !one.illustrative);
  const hold = world.holds.find((one) => one.projectId === project.id && one.state === "ACTIVE");
  const payment = world.payments.find((one) => one.projectId === project.id);
  const { uploadStartedAt, packageReadyAt, importTerminalAt, receiptAt } = project.dates;
  const files = unpaidFilesEnd(project);
  switch (project.step) {
    case "SOURCES":
    case "SELECTION":
    case "SEAL":
      return uploadStartedAt === null ? null : { ends: "UPLOAD", at: plusHours(uploadStartedAt, R.uploadReservationSeconds / 3600) };
    case "CHECK":
      if (project.check?.state === "RUNNING") return { ends: "RESULTS", at: project.check.deadline };
      return files === null ? null : { ends: "FILES", at: files };
    case "TARGET":
    case "MAPPING":
    case "DUPLICATES":
    case "RELATIONSHIPS":
    case "APPROVAL":
      return files === null ? null : { ends: "FILES", at: files };
    case "QUOTE":
    case "PAYMENT": {
      if (hold !== undefined) return { ends: "HOLD", at: hold.until };
      if (files === null) return null;
      if (quote === undefined || ms(files) <= ms(quote.expiresAt)) return { ends: "FILES", at: files };
      return { ends: "QUOTE", at: quote.expiresAt };
    }
    case "PROCESSING":
    case "RETENTION":
      return null;
    case "DELIVERY":
    case "IMPORT":
      if (packageReadyAt === null || payment === undefined) return null;
      return project.service === "SALESFORCE"
        ? { ends: "STAGED_PACKAGE", at: earliest(plusDays(packageReadyAt, R.stagedDaysFromFirstRelease), plusDays(payment.receivedAt, R.stagedDaysHardFromCapture)) }
        : { ends: "PACKAGE", at: earliest(plusDays(packageReadyAt, R.paidDaysFromFirstPackage), plusDays(payment.receivedAt, R.paidDaysHardFromCapture)) };
    case "RECEIPT":
      return receiptAt !== null || importTerminalAt === null ? null : { ends: "RECEIPT", at: plusDays(importTerminalAt, R.importReceiptDaysFromTerminal) };
  }
}

/** Every step's facts are present (and later steps' facts absent), dates run in order, and the date that matters follows the policy. */
export function checkProjects(world: World): readonly string[] {
  const problems: Problems = [];
  const now = ms(world.asOf);
  const steps = new Set<Step>();
  for (const project of world.projects) {
    steps.add(project.step);
    const name = `project ${project.name} (${project.id.slice(-4)})`;
    const d = project.dates;
    const quote = world.quotes.find((one) => one.projectId === project.id && !one.illustrative);
    const order = world.orders.find((one) => one.projectId === project.id);
    const payment = world.payments.find((one) => one.projectId === project.id);
    const workspace = world.workspaces.find((one) => one.id === project.workspaceId);
    if (project.example !== (workspace?.kind === "EXAMPLE")) problems.push(`${name}: only the example workspace holds the example project`);
    if (workspace !== undefined && ms(workspace.createdAt) > ms(d.createdAt)) problems.push(`${name}: created before its workspace`);
    // what each step needs
    const want = (condition: boolean, what: string): void => {
      if (!condition) problems.push(`${name} at ${project.step}: ${what}`);
    };
    want(d.uploadStartedAt !== null, "an upload has started");
    if (reached(project, "CHECK")) want(project.check !== null && d.checkStartedAt !== null, "a check has started");
    if (!reached(project, "CHECK")) want(project.check === null && d.checkStartedAt === null, "no check before the CHECK step");
    if (reached(project, "MAPPING")) want(project.check?.state === "READY" && d.checkReadyAt !== null, "the check is ready");
    if (project.check !== null) {
      want((project.check.state === "READY") === (d.checkReadyAt !== null), "a ready check has its ready date, and only it");
      want((project.check.state === "FAILED") === (project.check.failure !== null), "a failed check says why, and only it");
      if (d.checkStartedAt !== null) want(ms(project.check.deadline) > ms(d.checkStartedAt) && ms(project.check.deadline) <= ms(d.checkStartedAt) + R.uploadReservationSeconds * 1000, "the check's deadline is within 24 hours of its start");
    }
    if (reached(project, "QUOTE") && !project.example) want(quote !== undefined && d.planApprovedAt !== null, "an approved plan and a quote");
    if (!reached(project, "QUOTE")) want(quote === undefined && d.planApprovedAt === null, "no approval or quote before the QUOTE step");
    if (reached(project, "PAYMENT") && !project.example) want(order !== undefined, "a payment order");
    if (!reached(project, "PAYMENT") || project.example) want(order === undefined, "no payment order");
    if (project.step === "PAYMENT") want(order !== undefined && (order.state === "AWAITING_TRANSFER" || order.state === "HELD_PENDING_TRANSFER") && payment === undefined, "the order waits for a transfer, nothing is paid");
    if (reached(project, "PROCESSING") && !project.example) want(payment !== undefined && d.preparationStartedAt !== null, "a confirmed payment and a preparation");
    if (!reached(project, "PROCESSING") || project.example) want(payment === undefined, "no payment");
    if (!reached(project, "PROCESSING")) want(d.preparationStartedAt === null, "no preparation before payment");
    if (reached(project, "DELIVERY")) want(d.packageReadyAt !== null && project.outputs.length > 0, "a package with its files");
    if (!reached(project, "DELIVERY")) want(d.packageReadyAt === null && project.outputs.length === 0, "no package before delivery");
    if (reached(project, "IMPORT") && project.step !== "RETENTION") want(project.service !== "CLEAN" && project.importStages.length > 0, "a CRM service with import stages");
    if (project.step === "RECEIPT") want(d.importTerminalAt !== null, "the import reported finished");
    if (project.step === "RETENTION") want(d.deletedAt !== null && d.completedAt !== null, "completed, then deleted");
    if (project.step !== "RETENTION") want(d.deletedAt === null, "nothing deleted while the project runs");
    if (d.completedAt !== null) want(d.packageReadyAt !== null && ms(d.completedAt) >= ms(d.packageReadyAt), "completion after the package");
    if (d.packageDeletedAt !== null) want(d.packageReadyAt !== null && ms(d.packageDeletedAt) >= ms(d.packageReadyAt), "the package deleted after it was ready");
    if (project.example) want(quote === undefined && world.quotes.some((one) => one.projectId === project.id && one.illustrative), "only an illustrative quote");
    // dates in order, none after now
    const chain: readonly (readonly [string, string | null])[] = [
      ["created", d.createdAt],
      ["upload", d.uploadStartedAt],
      ["seal", d.sealedAt],
      ["check start", d.checkStartedAt],
      ["check ready", d.checkReadyAt],
      ["approval", d.planApprovedAt],
      ["quote", quote?.issuedAt ?? null],
      ["order", order?.createdAt ?? null],
      ["payment", payment?.receivedAt ?? null],
      ["preparation", d.preparationStartedAt],
      ["package", d.packageReadyAt],
      ["import finished", d.importTerminalAt],
      ["receipt", d.receiptAt],
    ];
    let previous: readonly [string, string] | null = null;
    for (const [label, value] of chain) {
      if (value === null) continue;
      if (previous !== null && ms(value) < ms(previous[1])) problems.push(`${name}: ${label} (${value}) comes before ${previous[0]} (${previous[1]})`);
      previous = [label, value];
    }
    const known = [...chain.map(([, value]) => value), d.completedAt, d.packageDeletedAt, d.deletedAt].filter((value): value is string => value !== null);
    for (const value of known) if (ms(value) > now) problems.push(`${name}: ${value} is after the world's now`);
    if (ms(d.lastProgressAt) > now || known.some((value) => ms(value) > ms(d.lastProgressAt))) problems.push(`${name}: its last progress is its latest date, and not after now`);
    if (d.deletedAt !== null && known.some((value) => ms(value) > ms(d.deletedAt as string))) problems.push(`${name}: something happens after its files were deleted`);
    // the date that matters
    const expected = expectedMatters(world, project);
    if (JSON.stringify(expected) !== JSON.stringify(project.matters)) problems.push(`${name}: the date that matters is ${JSON.stringify(project.matters)}, the policy gives ${JSON.stringify(expected)}`);
  }
  return problems;
}

/** The step coverage the canonical world promises (every step is some project's current step); stress worlds need not. */
export function missingSteps(world: World): readonly Step[] {
  return STEPS.filter((step) => !world.projects.some((one) => one.step === step));
}

// ---- customer money --------------------------------------------------------------------------------------------------------------------

const paymentsBefore = (world: World, workspaceId: string, before: string): number =>
  world.payments.filter((one) => one.workspaceId === workspaceId && ms(one.receivedAt) < ms(before) && ms(one.receivedAt) >= ms(before) - POLICY_SNAPSHOT.repeatLookbackDays * 86_400_000).length;

/** Quotes from the policy; orders, payments and holds equal to their quote; refunds within what was paid; tax always apart. */
export function checkMoney(world: World): readonly string[] {
  const problems: Problems = [];
  for (const quote of world.quotes) {
    const name = `quote ${quote.number}`;
    const project = world.projects.find((one) => one.id === quote.projectId);
    const workspace = world.workspaces.find((one) => one.id === project?.workspaceId);
    if (project === undefined || workspace === undefined) continue;
    if (quote.illustrative !== project.example) problems.push(`${name}: only the public sample's quote is illustrative`);
    if (quote.service !== project.service) problems.push(`${name}: quotes another service than its project`);
    if (quote.units !== project.units) problems.push(`${name}: quotes ${quote.units} units, the project sealed ${project.units}`);
    const band = bandIndexOf(quote.units);
    if (band === null || quote.units > POLICY_SNAPSHOT.launchSourceUnits) problems.push(`${name}: ${quote.units} units cannot be quoted`);
    if (band !== quote.band) problems.push(`${name}: band ${quote.band}, the units fall in band ${band}`);
    if (band !== null && quote.listMinor !== priceOf(band, quote.service)) problems.push(`${name}: list price ${quote.listMinor} is not the band's ${priceOf(band, quote.service)}`);
    if (quote.scheduleVersion !== POLICY_SNAPSHOT.scheduleVersion) problems.push(`${name}: another price schedule`);
    const prior = quote.illustrative ? 0 : paymentsBefore(world, workspace.id, quote.issuedAt);
    if (quote.priorPaidProjects !== prior) problems.push(`${name}: ${quote.priorPaidProjects} prior paid projects stated, ${prior} found`);
    if (quote.discountPercent !== repeatPercent(prior)) problems.push(`${name}: a ${quote.discountPercent}% discount, the repeat ladder gives ${repeatPercent(prior)}%`);
    if (quote.discountMinor !== Math.round((quote.listMinor * quote.discountPercent) / 100)) problems.push(`${name}: the discount amount is not its percent of the list price`);
    if (quote.serviceMinor !== quote.listMinor - quote.discountMinor) problems.push(`${name}: service is not list less discount`);
    if (quote.taxRateBps !== workspace.taxRateBps) problems.push(`${name}: the tax rate is not the buyer's`);
    if (quote.taxMinor !== ofBps(quote.serviceMinor, quote.taxRateBps)) problems.push(`${name}: the tax is not its rate of the service`);
    if (quote.totalMinor !== quote.serviceMinor + quote.taxMinor) problems.push(`${name}: the total is not service plus tax`);
    if (quote.expiresAt !== plusDays(quote.issuedAt, POLICY_SNAPSHOT.quoteDays)) problems.push(`${name}: not valid exactly ${POLICY_SNAPSHOT.quoteDays} days`);
    if (!quote.illustrative && project.dates.planApprovedAt !== null && ms(quote.issuedAt) < ms(project.dates.planApprovedAt)) problems.push(`${name}: issued before the plan was approved`);
    const order = world.orders.find((one) => one.quoteId === quote.id);
    const expectedState = world.payments.some((one) => one.orderId === order?.id) ? "PAID" : order !== undefined ? "ORDERED" : ms(quote.expiresAt) <= ms(world.asOf) && !quote.illustrative ? "EXPIRED" : "ISSUED";
    if (quote.state !== expectedState) problems.push(`${name}: state ${quote.state}, its orders and payments say ${expectedState}`);
    if (world.quotes.filter((one) => one.projectId === quote.projectId).length > 1) problems.push(`${name}: a project has one quote in this world`);
  }
  for (const project of world.projects) {
    if (project.units !== null && bandIndexOf(project.units) === null && world.quotes.some((one) => one.projectId === project.id)) problems.push(`project ${project.name}: beyond the ladder, yet quoted`);
  }
  for (const order of world.orders) {
    const name = `order ${order.reference}`;
    const quote = world.quotes.find((one) => one.id === order.quoteId);
    const project = world.projects.find((one) => one.id === order.projectId);
    if (quote === undefined || project === undefined) continue;
    if (order.amountMinor !== quote.totalMinor) problems.push(`${name}: amount ${order.amountMinor} is not the quote's total ${quote.totalMinor}`);
    if (ms(order.createdAt) < ms(quote.issuedAt) || ms(order.createdAt) >= ms(quote.expiresAt)) problems.push(`${name}: created outside its quote's validity`);
    const files = unpaidFilesEnd(project);
    const closes = files === null ? quote.expiresAt : earliest(quote.expiresAt, files);
    const sendBy = `${dayPlus(closes.slice(0, 10), -4)}T23:59:59Z`;
    if (order.sendBy !== sendBy) problems.push(`${name}: send by ${order.sendBy}, the rule gives ${sendBy}`);
    const payments = world.payments.filter((one) => one.orderId === order.id);
    const hold = world.holds.find((one) => one.orderId === order.id);
    if (payments.length > 1) problems.push(`${name}: paid more than once`);
    if ((order.state === "PAID") !== (payments.length === 1)) problems.push(`${name}: PAID exactly when a payment is confirmed`);
    if ((order.state === "HELD_PENDING_TRANSFER") !== (hold?.state === "ACTIVE")) problems.push(`${name}: held exactly while a hold is active`);
  }
  for (const hold of world.holds) {
    const name = `hold ${hold.id}`;
    const order = world.orders.find((one) => one.id === hold.orderId);
    const project = world.projects.find((one) => one.id === hold.projectId);
    if (order === undefined || project === undefined || project.dates.sealedAt === null) continue;
    if (order.projectId !== hold.projectId) problems.push(`${name}: names another project than its order`);
    if (world.holds.filter((one) => one.orderId === hold.orderId || one.projectId === hold.projectId).length > 1) problems.push(`${name}: one hold per quote and per sealed set, never renewed`);
    const ceiling = plusDays(project.dates.sealedAt, PROPOSED.unpaidCeilingDays);
    if (hold.ceiling !== ceiling) problems.push(`${name}: ceiling ${hold.ceiling}, 24 days from sealing is ${ceiling}`);
    const until = earliest(plusBusinessDays(hold.proofAt, PROPOSED.holdBusinessDays, world.holidays), ceiling);
    if (hold.until !== until) problems.push(`${name}: until ${hold.until}, five business days from the proof give ${until}`);
    const files = unpaidFilesEnd(project);
    if (ms(hold.proofAt) < ms(order.createdAt) || (files !== null && ms(hold.proofAt) > ms(files))) problems.push(`${name}: the proof comes after the order and before the files would go`);
    const role = roleOf(world, hold.givenBy, project.workspaceId);
    if (role !== "OWNER" && role !== "BILLING") problems.push(`${name}: given by someone who is neither an owner nor billing`);
    if (hold.state === "ACTIVE" && ms(hold.until) <= ms(world.asOf)) problems.push(`${name}: active past its end`);
  }
  const invoices = new Set<string>();
  for (const payment of world.payments) {
    const name = `payment ${payment.id}`;
    const order = world.orders.find((one) => one.id === payment.orderId);
    const quote = world.quotes.find((one) => one.id === order?.quoteId);
    const project = world.projects.find((one) => one.id === payment.projectId);
    if (order === undefined || quote === undefined || project === undefined) continue;
    if (payment.amountMinor !== order.amountMinor || payment.amountMinor !== quote.totalMinor) problems.push(`${name}: ${payment.amountMinor} received, the order and quote say ${order.amountMinor} and ${quote.totalMinor}`);
    if (payment.serviceMinor !== quote.serviceMinor || payment.taxMinor !== quote.taxMinor) problems.push(`${name}: service and tax are not the quote's`);
    if (payment.amountMinor !== payment.serviceMinor + payment.taxMinor) problems.push(`${name}: received is not service plus tax`);
    if (payment.workspaceId !== project.workspaceId || order.projectId !== payment.projectId) problems.push(`${name}: names another workspace or project than its order`);
    if (ms(payment.receivedAt) < ms(order.createdAt) || ms(payment.receivedAt) > ms(order.sendBy)) problems.push(`${name}: received outside its order's window`);
    if (invoices.has(payment.invoice)) problems.push(`${name}: invoice ${payment.invoice} used twice`);
    invoices.add(payment.invoice);
  }
  for (const refund of world.refunds) {
    const name = `refund ${refund.id}`;
    const payment = world.payments.find((one) => one.id === refund.paymentId);
    const workspace = world.workspaces.find((one) => one.id === payment?.workspaceId);
    if (payment === undefined || workspace === undefined) continue;
    const refunded = world.refunds.filter((one) => one.paymentId === payment.id);
    if (sum(refunded.map((one) => one.serviceMinor)) > payment.serviceMinor || sum(refunded.map((one) => one.taxMinor)) > payment.taxMinor) problems.push(`${name}: refunds more than was paid`);
    if (refund.taxMinor !== ofBps(refund.serviceMinor, workspace.taxRateBps)) problems.push(`${name}: the tax refunded is not the tax on the service refunded`);
    if (refund.projectId !== payment.projectId) problems.push(`${name}: names another project than its payment`);
    if (ms(refund.approvedAt) < ms(payment.receivedAt) || ms(refund.paidAt) < ms(refund.approvedAt) || ms(refund.paidAt) > ms(world.asOf)) problems.push(`${name}: dates out of order`);
  }
  for (const claim of world.refundClaims) {
    const name = `refund request ${claim.id}`;
    const payment = world.payments.find((one) => one.id === claim.paymentId);
    if (payment === undefined) continue;
    if (payment.projectId !== claim.projectId) problems.push(`${name}: names another project than its payment`);
    if (claim.serviceMinor > payment.serviceMinor) problems.push(`${name}: asks for more than the service paid`);
    if ((claim.state === "PENDING_LEGAL_REVIEW") !== (claim.decidedAt === null)) problems.push(`${name}: decided exactly when it is no longer pending`);
    if (claim.customerMessage.includes(claim.internalReason) || claim.customerMessage.length === 0) problems.push(`${name}: the customer reads a neutral message, never the internal reason`);
    if (ms(claim.requestedAt) < ms(payment.receivedAt)) problems.push(`${name}: requested before the payment`);
  }
  return problems;
}

// ---- seller money ------------------------------------------------------------------------------------------------------------------------

const isPaidStatement = (world: World, id: string | null): boolean => id !== null && world.statements.some((one) => one.id === id && one.state === "PAID");

/**
 * Commission is the agreement's rate on the service collected (never tax), one line per collection; offsets are the rate on the service
 * refunded, with balance = basis − applied; statements add up; pending + paid = generated; payouts never exceed what was paid.
 */
export function checkSellers(world: World): readonly string[] {
  const problems: Problems = [];
  const today = bogotaDay(world.asOf);
  const used = new Set<string>();
  for (const workspace of world.workspaces) {
    const payments = world.payments.filter((one) => one.workspaceId === workspace.id).sort((a, b) => ms(a.receivedAt) - ms(b.receivedAt));
    const first = payments[0];
    const sellerId = workspace.acquiredBySellerId;
    const claim = world.claims.find((one) => one.id === workspace.claimId);
    if (sellerId !== null) {
      if (claim === undefined || claim.state !== "CONVERTED" || claim.sellerId !== sellerId || claim.workspaceId !== workspace.id) problems.push(`workspace ${workspace.name}: acquired through a converted claim of the same seller`);
      if (first === undefined || claim?.convertedOn !== bogotaDay(first.receivedAt)) problems.push(`workspace ${workspace.name}: the claim converts on the first confirmed payment`);
    } else if (claim !== undefined && claim.state === "CONVERTED") problems.push(`workspace ${workspace.name}: a converted claim makes it acquired`);
    for (const payment of payments) {
      const lines = world.commissionLines.filter((one) => one.paymentId === payment.id);
      const inWindow = first !== undefined && ms(payment.receivedAt) < ms(`${dayPlus(bogotaDay(first.receivedAt), 365)}T05:00:00Z`);
      const expected = sellerId !== null && inWindow ? 1 : 0;
      if (lines.length !== expected) problems.push(`payment ${payment.id}: ${lines.length} commission lines, expected ${expected}`);
    }
  }
  for (const line of world.commissionLines) {
    const name = `line ${line.id}`;
    if (used.has(line.paymentId)) problems.push(`${name}: a collection counted twice`);
    used.add(line.paymentId);
    const payment = world.payments.find((one) => one.id === line.paymentId);
    const seller = world.sellers.find((one) => one.id === line.sellerId);
    const project = world.projects.find((one) => one.id === line.projectId);
    const workspace = world.workspaces.find((one) => one.id === line.workspaceId);
    if (payment === undefined || seller === undefined || project === undefined || workspace === undefined) continue;
    if (workspace.acquiredBySellerId !== seller.id) problems.push(`${name}: the customer was not acquired by this seller`);
    if (payment.projectId !== project.id || payment.workspaceId !== workspace.id) problems.push(`${name}: payment, project and workspace disagree`);
    const first = world.payments.filter((one) => one.workspaceId === workspace.id).sort((a, b) => ms(a.receivedAt) - ms(b.receivedAt))[0];
    const sequence = first?.id === payment.id ? "FIRST" : "REPEAT";
    if (line.sequence !== sequence) problems.push(`${name}: ${line.sequence}, the customer's payments make it ${sequence}`);
    const rate = sequence === "FIRST" ? seller.agreement.firstRateBps : seller.agreement.repeatRateBps;
    if (line.rateBps !== rate) problems.push(`${name}: rate ${line.rateBps}, the agreement gives ${rate}`);
    if (line.basisMinor !== payment.serviceMinor) problems.push(`${name}: basis ${line.basisMinor} is not the service collected ${payment.serviceMinor} (tax is never commissioned)`);
    if (line.amountMinor !== ofBps(line.basisMinor, line.rateBps)) problems.push(`${name}: amount is not rate × basis`);
    const completed = project.dates.completedAt === null ? null : bogotaDay(project.dates.completedAt);
    if (line.completedOn !== completed) problems.push(`${name}: completed on ${line.completedOn}, the project says ${completed}`);
    const payableFrom = completed === null ? null : dayPlus(completed, COMMISSION.eligibilityDaysAfterFinalCompletion);
    if (line.payableFrom !== payableFrom) problems.push(`${name}: payable from ${line.payableFrom}, the rule gives ${payableFrom}`);
    const state = isPaidStatement(world, line.statementId) ? "PAID" : line.hold !== null ? "HELD" : payableFrom === null || payableFrom > today ? "ACCRUED" : "PAYABLE";
    if (line.state !== state) problems.push(`${name}: state ${line.state}, its facts give ${state}`);
    const statement = world.statements.find((one) => one.id === line.statementId);
    if (statement !== undefined && (statement.sellerId !== seller.id || payableFrom === null || statement.period !== payableFrom.slice(0, 7))) problems.push(`${name}: on the statement of another seller or month`);
    if (line.statementId === null && payableFrom !== null) problems.push(`${name}: payable lines belong to their month's statement`);
  }
  for (const offset of world.offsets) {
    const name = `offset ${offset.id}`;
    const refund = world.refunds.find((one) => one.id === offset.refundId);
    const line = world.commissionLines.find((one) => one.id === offset.adjustsLineId);
    if (refund === undefined || line === undefined) continue;
    if (line.paymentId !== refund.paymentId || line.sellerId !== offset.sellerId) problems.push(`${name}: adjusts a line of another payment or seller`);
    if (offset.rateBps !== line.rateBps) problems.push(`${name}: another rate than the line it adjusts`);
    if (offset.basisMinor !== ofBps(refund.serviceMinor, offset.rateBps)) problems.push(`${name}: basis ${offset.basisMinor} is not the rate on the service refunded (tax refunded is never part of it)`);
    if (offset.appliedMinor < 0 || offset.appliedMinor > offset.basisMinor) problems.push(`${name}: applied more than its basis`);
    if (offset.balanceMinor !== offset.basisMinor - offset.appliedMinor) problems.push(`${name}: balance is not basis less applied`);
    const statement = world.statements.find((one) => one.id === offset.statementId);
    if (statement !== undefined && (statement.sellerId !== offset.sellerId || statement.period < bogotaDay(refund.approvedAt).slice(0, 7))) problems.push(`${name}: shown on a statement of another seller or before the refund`);
  }
  for (const refund of world.refunds) {
    const line = world.commissionLines.find((one) => one.paymentId === refund.paymentId);
    const offsets = world.offsets.filter((one) => one.refundId === refund.id);
    if (offsets.length !== (line === undefined ? 0 : 1)) problems.push(`refund ${refund.id}: a refund on a commissioned collection has exactly one offset`);
  }
  for (const seller of world.sellers) {
    const name = `seller ${seller.name}`;
    const { agreement } = seller;
    if (agreement.retainerMinorPerMonth > 0 && (agreement.signedOn === null || agreement.retainerFrom === null)) problems.push(`${name}: a retainer needs a signed agreement and a start`);
    if (agreement.retainerMinorPerMonth === 0 && agreement.retainerFrom !== null) problems.push(`${name}: no retainer, no retainer start`);
    if (seller.state === "CANDIDATE" && (agreement.signedOn !== null || world.claims.some((one) => one.sellerId === seller.id) || world.commissionLines.some((one) => one.sellerId === seller.id))) problems.push(`${name}: a candidate has no signed agreement, claims or lines`);
    if (agreement.firstRateBps !== COMMISSION.firstBps || agreement.repeatRateBps !== COMMISSION.repeatBps) problems.push(`${name}: rates differ from the policy's defaults (state them beside the name)`);
    if (seller.setup.done > seller.setup.total || (seller.state !== "CANDIDATE" && seller.setup.done !== seller.setup.total)) problems.push(`${name}: setup steps`);
    const prospects = world.prospects.filter((one) => one.sellerId === seller.id).map((one) => one.lastActivityOn).sort();
    const last = prospects.at(-1) ?? null;
    if (seller.lastProgressOn !== last) problems.push(`${name}: last progress ${seller.lastProgressOn}, the prospects say ${last}`);
    const months: string[] = [];
    if (agreement.retainerFrom !== null) for (let month = agreement.retainerFrom.slice(0, 7); month <= today.slice(0, 7); month = nextMonth(month)) months.push(month);
    const retainers = world.retainerLines.filter((one) => one.sellerId === seller.id);
    if (retainers.map((one) => one.month).sort().join() !== months.join()) problems.push(`${name}: retainer lines ${retainers.map((one) => one.month).join()} for months ${months.join()}`);
    for (const one of retainers) {
      if (one.amountMinor !== agreement.retainerMinorPerMonth) problems.push(`retainer ${one.id}: not the agreement's amount`);
      if ((one.state === "PAID") !== isPaidStatement(world, one.statementId)) problems.push(`retainer ${one.id}: PAID exactly when its statement is`);
      const statement = world.statements.find((candidate) => candidate.id === one.statementId);
      if (statement !== undefined && statement.period !== one.month) problems.push(`retainer ${one.id}: on another month's statement`);
    }
    // the two figures, and their identities
    const figures = sellerFigures(world, seller.id);
    if (figures.commissionPendingMinor + figures.commissionPaidMinor !== figures.commissionGeneratedMinor) problems.push(`${name}: pending ${figures.commissionPendingMinor} + paid ${figures.commissionPaidMinor} is not generated ${figures.commissionGeneratedMinor}`);
    const lines = world.commissionLines.filter((one) => one.sellerId === seller.id);
    const netByRate = sum(
      lines.map((line) => {
        const refunded = sum(world.refunds.filter((one) => one.paymentId === line.paymentId).map((one) => one.serviceMinor));
        return ofBps(line.basisMinor - refunded, line.rateBps);
      }),
    );
    if (netByRate !== figures.commissionGeneratedMinor) problems.push(`${name}: generated ${figures.commissionGeneratedMinor} is not rate × net attributable revenue (${netByRate})`);
    const collectedWithTax = sum(lines.map((line) => world.payments.find((one) => one.id === line.paymentId)?.amountMinor ?? 0)) - sum(world.refunds.filter((one) => lines.some((line) => line.paymentId === one.paymentId)).map((one) => one.serviceMinor + one.taxMinor));
    const taxNet = sum(lines.map((line) => world.payments.find((one) => one.id === line.paymentId)?.taxMinor ?? 0)) - sum(world.refunds.filter((one) => lines.some((line) => line.paymentId === one.paymentId)).map((one) => one.taxMinor));
    if (figures.netAttributableRevenueMinor !== collectedWithTax - taxNet) problems.push(`${name}: net attributable revenue includes tax`);
    if (figures.payoutsConfirmedMinor > figures.commissionPaidMinor + figures.retainerPaidMinor) problems.push(`${name}: payouts ${figures.payoutsConfirmedMinor} exceed paid commission and retainer`);
    if (figures.commissionPendingMinor < 0 || figures.commissionPaidMinor < 0) problems.push(`${name}: a negative figure`);
  }
  for (const statement of world.statements) {
    const name = `statement ${statement.id}`;
    const next = nextMonth(statement.period);
    const issuedOn = nthBusinessDay(next, COMMISSION.statementBusinessDay, world.holidays);
    const payDue = nthBusinessDay(next, COMMISSION.payBusinessDay, world.holidays);
    if (statement.issuedOn !== issuedOn || statement.payDue !== payDue) problems.push(`${name}: issued ${statement.issuedOn} and due ${statement.payDue}, the calendar gives ${issuedOn} and ${payDue}`);
    const lines = world.commissionLines.filter((one) => one.statementId === statement.id);
    const commission = sum(lines.filter((one) => one.state !== "HELD").map((one) => one.amountMinor));
    const held = sum(lines.filter((one) => one.state === "HELD").map((one) => one.amountMinor));
    const offsets = sum(world.offsets.filter((one) => one.statementId === statement.id).map((one) => one.appliedMinor));
    const retainer = sum(world.retainerLines.filter((one) => one.statementId === statement.id).map((one) => one.amountMinor));
    if (statement.commissionMinor !== commission || statement.heldMinor !== held || statement.offsetAppliedMinor !== offsets || statement.retainerMinor !== retainer) problems.push(`${name}: its figures are not its lines (${commission}, held ${held}, offsets ${offsets}, retainer ${retainer})`);
    if (statement.totalMinor !== commission - offsets + retainer || statement.totalMinor < 0) problems.push(`${name}: total is not commission less offsets plus retainer, held apart`);
    if (statement.state === "DRAFT" && statement.issuedOn <= today) problems.push(`${name}: a draft after its issue date`);
    if (statement.state !== "DRAFT" && statement.issuedOn > today) problems.push(`${name}: issued before its issue date`);
    const payouts = world.payouts.filter((one) => one.statementId === statement.id);
    if (statement.state === "PAID") {
      const confirmed = payouts.filter((one) => one.confirmedOn !== null);
      if (statement.paidOn === null || statement.reference === null || confirmed.length !== 1 || confirmed[0]?.amountMinor !== statement.totalMinor || confirmed[0]?.reference !== statement.reference || confirmed[0]?.confirmedOn !== statement.paidOn) problems.push(`${name}: paid exactly by one confirmed payout of its total, reference and date`);
      if (statement.paidOn !== null && statement.paidOn > statement.payDue) problems.push(`${name}: paid after its due date`);
    } else if (statement.paidOn !== null || payouts.some((one) => one.confirmedOn !== null)) problems.push(`${name}: an unpaid statement has no confirmed payout`);
    for (const payout of payouts) if (payout.amountMinor > statement.totalMinor || payout.sellerId !== statement.sellerId) problems.push(`payout ${payout.id}: more than its statement, or another seller`);
  }
  for (const claim of world.claims) {
    const name = `claim ${claim.id}`;
    const seller = world.sellers.find((one) => one.id === claim.sellerId);
    if (claim.decidedOn !== null && claim.decidedOn < claim.submittedOn) problems.push(`${name}: decided before submitted`);
    if ((claim.state === "SUBMITTED") !== (claim.decidedOn === null)) problems.push(`${name}: decided exactly when not submitted`);
    const accepted = claim.state === "ACCEPTED" || claim.state === "CONVERTED" || claim.state === "EXPIRED";
    const ends = accepted && claim.decidedOn !== null ? dayPlus(claim.decidedOn, COMMISSION.acceptedClaimDays) : null;
    if (claim.endsOn !== ends) problems.push(`${name}: ends ${claim.endsOn}, 90 days from the decision is ${ends}`);
    if (claim.state === "ACCEPTED" && ends !== null && ends < today) problems.push(`${name}: still accepted after its end`);
    if ((claim.state === "CONVERTED") !== (claim.convertedOn !== null) || (claim.convertedOn !== null && ends !== null && claim.convertedOn > ends)) problems.push(`${name}: converted within its 90 days, and only then`);
    if (claim.state === "REJECTED" && (claim.reason === null || claim.sellerMessage === null)) problems.push(`${name}: a refusal has a reason and the seller's message`);
    if (claim.state !== "REJECTED" && (claim.reason !== null || claim.sellerMessage !== null)) problems.push(`${name}: only a refusal has a reason`);
    if (claim.reason === "CUSTOMER_OR_DIRECT" || claim.reason === "OTHER_CLAIM" || claim.reason === "OWNER_RULE" || claim.reason === "OTHER") {
      if (claim.sellerMessage !== "Not available to claim") problems.push(`${name}: the seller reads the neutral message, never the relationship behind it`);
    }
    const workspace = world.workspaces.find((one) => one.id === claim.workspaceId);
    if (workspace !== undefined && claim.decidedOn !== null && bogotaDay(workspace.createdAt) < claim.decidedOn) problems.push(`${name}: the organisation was already in direct contact (its workspace predates the decision)`);
    if (seller !== undefined && seller.state === "CANDIDATE") problems.push(`${name}: a candidate cannot claim`);
  }
  return problems;
}

// ---- operations ----------------------------------------------------------------------------------------------------------------------

export function checkOperations(world: World): readonly string[] {
  const problems: Problems = [];
  const now = ms(world.asOf);
  for (const job of world.jobs) {
    const name = `job ${job.id}`;
    const shape =
      job.state === "QUEUED"
        ? job.startedAt === null && job.endedAt === null && job.failure === null
        : job.state === "RUNNING"
          ? job.startedAt !== null && job.endedAt === null && job.failure === null
          : job.state === "FAILED"
            ? job.startedAt !== null && job.endedAt !== null && job.failure !== null
            : job.startedAt !== null && job.endedAt !== null && job.failure === null;
    if (!shape) problems.push(`${name}: its dates and failure do not fit ${job.state}`);
    const times = [job.queuedAt, job.startedAt, job.endedAt].filter((value): value is string => value !== null);
    if (times.some((value, index) => index > 0 && ms(value) < ms(times[index - 1] as string)) || times.some((value) => ms(value) > now)) problems.push(`${name}: times out of order or after now`);
    const project = world.projects.find((one) => one.id === job.projectId);
    if (project !== undefined && job.kind === "PREPARATION" && (project.dates.preparationStartedAt === null || ms(job.queuedAt) < ms(project.dates.preparationStartedAt))) problems.push(`${name}: a preparation before the payment's preparation start`);
    if (project !== undefined && job.kind === "HEALTH_CHECK" && (project.dates.checkStartedAt === null || ms(job.queuedAt) < ms(project.dates.checkStartedAt))) problems.push(`${name}: a check job before the check`);
  }
  for (const project of world.projects) {
    if (project.step === "PROCESSING" && !world.jobs.some((one) => one.projectId === project.id && one.kind === "PREPARATION" && (one.state === "RUNNING" || one.state === "QUEUED"))) problems.push(`project ${project.name}: processing without a running preparation`);
    if (project.check?.state === "RUNNING" && !world.jobs.some((one) => one.projectId === project.id && one.kind === "HEALTH_CHECK" && one.state === "RUNNING")) problems.push(`project ${project.name}: a running check without a running job`);
  }
  for (const incident of world.incidents) {
    if ((incident.state === "RESOLVED") !== (incident.resolvedAt !== null)) problems.push(`incident ${incident.id}: resolved exactly when it has a resolution time`);
    if (incident.resolvedAt !== null && ms(incident.resolvedAt) < ms(incident.openedAt)) problems.push(`incident ${incident.id}: resolved before opened`);
  }
  for (const deletion of world.deletions) {
    const name = `deletion ${deletion.id}`;
    const project = world.projects.find((one) => one.id === deletion.projectId);
    if (project === undefined) continue;
    if ((deletion.state === "DONE") !== (deletion.doneAt !== null && deletion.receipt !== null)) problems.push(`${name}: done exactly with a time and a receipt`);
    if ((deletion.origin === "RETENTION_SCHEDULE") !== (deletion.requestedBy === null)) problems.push(`${name}: a person asks, or the schedule does`);
    if (deletion.requestedBy !== null) {
      const role = roleOf(world, deletion.requestedBy, project.workspaceId);
      if (role !== "OWNER" && role !== "ADMIN") problems.push(`${name}: requested by someone who is neither an owner nor an admin`);
    }
    if ((deletion.scope === "SOURCE_FILE") !== (deletion.target !== null)) problems.push(`${name}: a file deletion names its file`);
    if (deletion.target !== null && !project.sources.some((one) => one.name === deletion.target)) problems.push(`${name}: names a file the project does not have`);
    if (deletion.scope === "PROJECT" && deletion.state === "DONE" && project.dates.deletedAt !== deletion.doneAt) problems.push(`${name}: the project's deletion date is not the receipt's`);
    if (deletion.origin === "RETENTION_SCHEDULE" && deletion.doneAt !== null && project.dates.packageReadyAt !== null) {
      const payment = world.payments.find((one) => one.projectId === project.id);
      const due = payment === undefined ? null : earliest(plusDays(project.dates.packageReadyAt, R.paidDaysFromFirstPackage), plusDays(payment.receivedAt, R.paidDaysHardFromCapture));
      if (due !== deletion.doneAt) problems.push(`${name}: the schedule deletes at ${due}, not ${deletion.doneAt}`);
    }
  }
  for (const project of world.projects) {
    if (project.step === "RETENTION" && !world.deletions.some((one) => one.projectId === project.id && one.scope === "PROJECT" && one.state === "DONE")) problems.push(`project ${project.name}: deleted without a deletion receipt`);
  }
  for (const release of world.releases) if ((release.state === "PROMOTED") !== (release.promotedAt !== null)) problems.push(`release ${release.id}: promoted exactly when it has a promotion time`);
  for (const one of world.supportCases) {
    const name = `support case ${one.number}`;
    if ((one.state === "RESOLVED") !== (one.resolvedAt !== null)) problems.push(`${name}: resolved exactly when it has a resolution time`);
    if (one.state === "WAITING_KAURO" && one.nextAnswerDue === null) problems.push(`${name}: waiting for Kauro needs an answer date`);
    if (roleOf(world, one.openedBy, one.workspaceId) === null) problems.push(`${name}: opened by someone outside the workspace`);
    const project = world.projects.find((candidate) => candidate.id === one.projectId);
    if (one.kind === "DEFECT_REPORT") {
      const completed = project?.dates.completedAt ?? null;
      if (completed === null || ms(one.openedAt) > ms(plusDays(completed, POLICY_SNAPSHOT.support.defectReportDays))) problems.push(`${name}: a defect report is made within ${POLICY_SNAPSHOT.support.defectReportDays} days of completion`);
    }
  }
  return problems;
}

/** Every check, in one list. */
export function reconcile(world: World): readonly string[] {
  return [...checkReferences(world), ...checkPeople(world), ...checkCounts(world), ...checkProjects(world), ...checkMoney(world), ...checkSellers(world), ...checkOperations(world)];
}
