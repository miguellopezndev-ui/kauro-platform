// The decisions of UI39 Company finance, owner sections O1 (the bank route) and O2 (the inbound credits) as data (docs/design/B12-owner-
// screens.md D-B12S-2..D-B12S-5). Everything the sections show comes from the api's own DTOs: a route's state, versions and evidence hash
// (never the bank's numbers, which the owner's views never carry), a credit's facts as the bank reported them (an absent fee is Unknown,
// never zero). Every command runs through the OperationRunner (one subject version, or one open form, is one key: a double activation
// joins, a lost answer replays the same key) and every command that names an authorizationRef spends one fresh step-up proof.
import type {
  attributeBankCreditRequest,
  configureBankRouteRequest,
  enterBankCreditRequest,
  getBankRouteResponse200,
  listBankCreditsResponse200,
  uploadBankEvidenceArtifactRequest,
  uploadBankEvidenceArtifactResponse201,
} from "../../api/generated.ts";
import type { ApiAnswer } from "../../client/answer.ts";
import type { ApiClient } from "../../client/api-client.ts";
import type { IdentityCredential } from "../../client/identity/port.ts";
import type { FormHandle, OperationRunner, RunOutcome } from "../../client/operation-runner.ts";
import { type StateDecision, stateOfAnswer } from "../../client/states.ts";
import { message } from "../../copy/en.ts";
import { formatMoney } from "@kauro/ui";
import { runWithStepUp, type StepUpResult } from "../shared/step-up.tsx";

export type BankRouteView = getBankRouteResponse200["route"];
export type BankCreditView = listBankCreditsResponse200["data"]["credits"][number];
export type BankCreditState = BankCreditView["state"];
export type BankEvidenceMediaType = uploadBankEvidenceArtifactRequest["mediaType"];
export type RouteCommand = "VERIFY" | "ENABLE" | "DISABLE" | "REPLACE_DETAILS";
export type CreditCommand = "CONFIRM" | "ATTRIBUTE";

/** The credit states the owner's queue lists, in the order the section offers them (the api's default first). */
export const QUEUE_STATES: readonly BankCreditState[] = ["MATCH_REVIEW", "DRAFT_MANUAL", "OBSERVED", "RETURN_REVIEW", "MATCHED", "APPLIED"];

/** The commands a route's state permits (ACH-ROUTE §7.1-§7.3): verify a pending one, enable a verified (or re-roll an enabled) one, disable an enabled one; new details from any state. */
export function routeCommands(route: BankRouteView): readonly RouteCommand[] {
  switch (route.state) {
    case "PENDING_VERIFICATION":
      return ["VERIFY", "REPLACE_DETAILS"];
    case "VERIFIED":
      return ["ENABLE", "REPLACE_DETAILS"];
    case "ENABLED":
      return ["DISABLE", "REPLACE_DETAILS"];
    case "DISABLED":
      return ["REPLACE_DETAILS"];
  }
}

/** A bank artifact the owner holds, as the page read it from the chosen file. */
export interface EvidenceFile {
  readonly mediaType: BankEvidenceMediaType;
  readonly bytes: Uint8Array;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export type UploadOutcome =
  | { readonly kind: "UPLOADED"; readonly artifact: uploadBankEvidenceArtifactResponse201["artifact"] }
  | { readonly kind: "UPLOAD_REFUSED"; readonly decision: StateDecision };

/**
 * GAP-API-8: the file into the restricted store for its account. The hash is the page's own SHA-256 of the bytes it sends; an answer for
 * another account or another hash is never cited (UPLOAD_REFUSED, as a refusal of the api is).
 */
export async function uploadEvidence(client: ApiClient, accountRef: string, file: EvidenceFile): Promise<UploadOutcome> {
  const evidenceHash = hex(await crypto.subtle.digest("SHA-256", file.bytes as Uint8Array<ArrayBuffer>));
  let answer: ApiAnswer<uploadBankEvidenceArtifactResponse201>;
  try {
    answer = await client.call("uploadBankEvidenceArtifact", { path: { accountRef }, body: { mediaType: file.mediaType, contentBase64: base64(file.bytes), evidenceHash } });
  } catch {
    return { kind: "UPLOAD_REFUSED", decision: stateOfAnswer({ kind: "NO_ANSWER", reason: "ABORTED", status: null }) };
  }
  if (answer.kind !== "REPLY") return { kind: "UPLOAD_REFUSED", decision: stateOfAnswer(answer) };
  const artifact = answer.body.artifact;
  if (artifact.accountRef !== accountRef || artifact.evidenceHash !== evidenceHash) return { kind: "UPLOAD_REFUSED", decision: stateOfAnswer({ kind: "INTEGRITY", status: answer.status, correlationId: answer.correlationId, failure: "REPLY_FAILED_CONTRACT" }) };
  return { kind: "UPLOADED", artifact };
}

export type ConfigureInput = Omit<configureBankRouteRequest, "detailsArtifactRef" | "detailsEvidenceHash">;
export type ConfigureResult = { readonly kind: "RAN"; readonly outcome: RunOutcome<{ readonly route: BankRouteView }> } | Extract<UploadOutcome, { readonly kind: "UPLOAD_REFUSED" }>;

/** CMD201: the details file is stored first; the configure cites the returned reference and hash under the form's one key (no step-up). */
export async function configureRoute(client: ApiClient, runner: OperationRunner, form: FormHandle, input: ConfigureInput, details: EvidenceFile): Promise<ConfigureResult> {
  const uploaded = await uploadEvidence(client, input.accountRef, details);
  if (uploaded.kind !== "UPLOADED") return uploaded;
  const body: configureBankRouteRequest = { ...input, detailsArtifactRef: uploaded.artifact.artifactRef, detailsEvidenceHash: uploaded.artifact.evidenceHash };
  const outcome = await runner.run<{ readonly route: BankRouteView }>({
    command: "CMD201",
    subject: { kind: "FORM", form },
    send: (key) => client.call("configureBankRoute", { body, idempotencyKey: key }),
  });
  return { kind: "RAN", outcome };
}

type Obtain = () => Promise<IdentityCredential | null>;
type RouteRun = StepUpResult<RunOutcome<{ readonly route: BankRouteView }>>;
type CreditRun = StepUpResult<RunOutcome<{ readonly credit: BankCreditView }>>;
const routeSubject = (route: BankRouteView) => ({ kind: "SUBJECT" as const, subjectId: route.routeId, subjectVersion: route.version });
const creditSubject = (credit: BankCreditView) => ({ kind: "SUBJECT" as const, subjectId: credit.creditId, subjectVersion: credit.version });

/** CMD202: the owner's verification of a pending route, under the route version's key and one step-up proof. */
export function verifyRoute(client: ApiClient, runner: OperationRunner, route: BankRouteView, verificationEvidenceRef: string, obtain: Obtain): Promise<RouteRun> {
  return runWithStepUp({
    client,
    obtain,
    command: (proof) => {
      const body = { expectedVersion: route.routeVersion, verificationEvidenceRef, authorizationRef: proof.take() };
      return runner.run({ command: "CMD202", subject: routeSubject(route), send: (key) => client.call("verifyBankRoute", { path: { routeId: route.routeId }, body, idempotencyKey: key }) });
    },
  });
}

/** CMD203: the route enabled for a rollout and its participants. */
export function enableRoute(client: ApiClient, runner: OperationRunner, route: BankRouteView, rollout: "CONTROLLED" | "GENERAL", participants: readonly string[], obtain: Obtain): Promise<RouteRun> {
  return runWithStepUp({
    client,
    obtain,
    command: (proof) => {
      const body = { expectedVersion: route.routeVersion, rollout, participants: [...participants], authorizationRef: proof.take() };
      return runner.run({ command: "CMD203", subject: routeSubject(route), send: (key) => client.call("enableBankRoute", { path: { routeId: route.routeId }, body, idempotencyKey: key }) });
    },
  });
}

/** CMD204: the route disabled (no new instruction is issued; issued ones stay). A lost answer ends as Checking under the same key. */
export function disableRoute(client: ApiClient, runner: OperationRunner, route: BankRouteView, obtain: Obtain): Promise<RouteRun> {
  return runWithStepUp({
    client,
    obtain,
    command: (proof) => {
      const body = { expectedVersion: route.routeVersion, authorizationRef: proof.take() };
      return runner.run({ command: "CMD204", subject: routeSubject(route), send: (key) => client.call("disableBankRoute", { path: { routeId: route.routeId }, body, idempotencyKey: key }) });
    },
  });
}

/** CMD205: new details for the route's account: the file is stored first, the command cites it under the route version's key and one proof. */
export async function replaceRouteDetails(client: ApiClient, runner: OperationRunner, route: BankRouteView, details: EvidenceFile, obtain: Obtain): Promise<RouteRun | Extract<UploadOutcome, { readonly kind: "UPLOAD_REFUSED" }>> {
  const uploaded = await uploadEvidence(client, route.accountRef, details);
  if (uploaded.kind !== "UPLOADED") return uploaded;
  return runWithStepUp({
    client,
    obtain,
    command: (proof) => {
      const body = { expectedVersion: route.routeVersion, detailsArtifactRef: uploaded.artifact.artifactRef, detailsEvidenceHash: uploaded.artifact.evidenceHash, authorizationRef: proof.take() };
      return runner.run({ command: "CMD205", subject: routeSubject(route), send: (key) => client.call("replaceBankRouteDetails", { path: { routeId: route.routeId }, body, idempotencyKey: key }) });
    },
  });
}

/** GAP-API-9: one page of the owner's queue of one state; the next page continues the same state with the page's cursor. */
export function listCredits(client: ApiClient, state: BankCreditState, cursor: string | null, signal?: AbortSignal): Promise<ApiAnswer<listBankCreditsResponse200>> {
  return client.call("listBankCredits", { query: cursor === null ? { state } : { state, cursor }, ...(signal === undefined ? {} : { signal }) });
}

export type QueueRead =
  | { readonly kind: "READY"; readonly credits: readonly BankCreditView[]; readonly nextCursor: string | null }
  | { readonly kind: "REFUSED"; readonly decision: StateDecision };

/** The queue's answer as the section shows it: the page, or the shared state of a refusal (nothing of a credit beside it). */
export function queueRead(answer: ApiAnswer<listBankCreditsResponse200>): QueueRead {
  if (answer.kind === "REPLY") return { kind: "READY", credits: answer.body.data.credits, nextCursor: answer.body.data.nextCursor };
  return { kind: "REFUSED", decision: stateOfAnswer(answer) };
}

export interface CreditRow {
  readonly gross: string;
  /** The fee the bank reported, or Unknown: an absent fee is never shown as zero. */
  readonly fee: string;
  readonly commands: readonly CreditCommand[];
}

/** A credit's row: its money as reported and the one command its state permits (a draft is confirmed, a reviewed credit is attributed). */
export function creditRow(credit: BankCreditView): CreditRow {
  return {
    gross: formatMoney(credit.grossCents, credit.currency),
    fee: credit.feeCents === null ? message("screen.finance.credit.fee.unknown") : formatMoney(credit.feeCents, credit.currency),
    commands: credit.state === "DRAFT_MANUAL" ? ["CONFIRM"] : credit.state === "MATCH_REVIEW" ? ["ATTRIBUTE"] : [],
  };
}

/** CMD211: the owner confirms a draft against its verified artifact, under the credit version's key and one step-up proof. */
export function confirmCredit(client: ApiClient, runner: OperationRunner, credit: BankCreditView, obtain: Obtain): Promise<CreditRun> {
  return runWithStepUp({
    client,
    obtain,
    command: (proof) => {
      const body = { expectedVersion: credit.version, authorizationRef: proof.take() };
      return runner.run({ command: "CMD211", subject: creditSubject(credit), send: (key) => client.call("confirmBankCredit", { path: { creditId: credit.creditId }, body, idempotencyKey: key }) });
    },
  });
}

export type AttributeInput = Omit<attributeBankCreditRequest, "expectedVersion" | "authorizationRef">;

/** CMD212: the owner attributes a reviewed credit to an order on the customer's billing evidence. */
export function attributeCredit(client: ApiClient, runner: OperationRunner, credit: BankCreditView, input: AttributeInput, obtain: Obtain): Promise<CreditRun> {
  return runWithStepUp({
    client,
    obtain,
    command: (proof) => {
      const body: attributeBankCreditRequest = { expectedVersion: credit.version, ...input, authorizationRef: proof.take() };
      return runner.run({ command: "CMD212", subject: creditSubject(credit), send: (key) => client.call("attributeBankCredit", { path: { creditId: credit.creditId }, body, idempotencyKey: key }) });
    },
  });
}

export type EnterFacts = Omit<enterBankCreditRequest, "evidence" | "authorizationRef">;
export type EnterResult = CreditRun | Extract<UploadOutcome, { readonly kind: "UPLOAD_REFUSED" }>;

/** CMD210: the bank artifact is stored first; the typed facts cite its reference and hash under the form's key and one step-up proof. */
export async function enterCredit(client: ApiClient, runner: OperationRunner, form: FormHandle, accountRef: string, facts: EnterFacts, artifact: EvidenceFile, obtain: Obtain): Promise<EnterResult> {
  const uploaded = await uploadEvidence(client, accountRef, artifact);
  if (uploaded.kind !== "UPLOADED") return uploaded;
  const evidence = { artifactRef: uploaded.artifact.artifactRef, evidenceHash: uploaded.artifact.evidenceHash };
  return runWithStepUp({
    client,
    obtain,
    command: (proof) => {
      const body: enterBankCreditRequest = { ...facts, evidence, authorizationRef: proof.take() };
      return runner.run<{ readonly credit: BankCreditView }>({ command: "CMD210", subject: { kind: "FORM", form }, send: (key) => client.call("enterBankCredit", { path: { accountRef }, body, idempotencyKey: key }) });
    },
  });
}
