import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MigrationError } from '../domain/errors.js';
import { decodeSource } from '../ingest/encoding.js';
import { sha256Hex } from '../util/hash.js';
import { compareCodeUnits, parseJson } from '../util/json.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import { TARGET_CONTRACT_VERSION, TARGET_PARSER_VERSION } from './contract.js';
import type {
  TargetArtifactRef,
  TargetContract,
  TargetFieldContract,
  TargetFlag,
  TargetInstanceIdentity,
  TargetObjectContract,
  TargetPicklistValue,
  TargetRecordType,
} from './contract.js';

/**
 * The Salesforce target bundle.
 *
 * Kauro holds no OAuth credential and calls no Salesforce endpoint. Everything
 * this module knows about an org arrives as files the agency produced with the
 * official Salesforce CLI on their own machine and then handed over. The
 * reader's whole job is to refuse what it cannot read unambiguously, and to
 * refuse anything that carries a credential at all.
 *
 * ## The bundle a runbook asks for
 *
 *     <bundle>/
 *       manifest.json                          the closed list of files this reader will open
 *       org.json                               sf org display --target-org <alias> --json
 *       attestation.json                       written by the agency, shape below
 *       describe/Account.json                  sf sobject describe --sobject Account --target-org <alias> --json
 *       describe/Contact.json                  sf sobject describe --sobject Contact --target-org <alias> --json
 *       describe/Lead.json                     sf sobject describe --sobject Lead --target-org <alias> --json
 *       describe/Opportunity.json              sf sobject describe --sobject Opportunity --target-org <alias> --json
 *       describe/OpportunityContactRole.json   only when that capability is being qualified
 *
 * Account, Contact, Lead and Opportunity are required, because those are the
 * four objects the SALESFORCE mode addresses and a contract that cannot speak
 * for one of them cannot speak for the migration. A describe for any further
 * object is carried rather than refused: it is a fact about the org, and
 * discarding evidence is not a safety property.
 *
 * ## manifest.json
 *
 * The manifest is the closed set. A file in the bundle that the manifest does
 * not declare is refused rather than ignored, and a file the manifest declares
 * that is not present is refused rather than skipped. Both directions matter:
 * the first is how something gets in beside the real artifacts, the second is
 * how a bundle quietly becomes a smaller one.
 *
 *     {
 *       "bundleFormat": "kauro-salesforce-target-bundle/1",
 *       "files": [
 *         { "path": "org.json",              "kind": "SALESFORCE_ORG_SUMMARY" },
 *         { "path": "attestation.json",      "kind": "SALESFORCE_ATTESTATION" },
 *         { "path": "describe/Account.json", "kind": "SALESFORCE_DESCRIBE", "sobject": "Account" }
 *       ]
 *     }
 *
 * `sobject` is required on a describe entry and refused on any other, and it is
 * checked against the `name` the describe itself carries. The manifest naming
 * one object while the file describes another is a bundle nobody can read
 * correctly, whichever of the two is believed.
 *
 * ## attestation.json
 *
 *     {
 *       "capturedAt": "2026-08-30T11:04:00Z",
 *       "capturedBy": "the person who ran the commands",
 *       "cliVersion": "2.136.8"
 *     }
 *
 * `capturedAt` is when the agency exported, as the agency stated it. It is not
 * when this ran, and nothing here reads a clock. `cliVersion` is recorded by
 * hash and deliberately not used as a gate: a version string is a claim, and
 * the secret scan below is the actual defence. Refusing on a version number
 * would let a bundle through by editing three characters.
 *
 * ## The manifest and the attestation are closed shapes; vendor output is not
 *
 * A describe gains attributes between API versions, so an unknown key in one is
 * tolerated and never becomes authority. The manifest and the attestation are
 * Kauro's own shapes and are hand-authored, so an unknown key in either is a
 * mistake or an injection and is refused by name. The org summary is vendor
 * output again, so unknown keys are tolerated there too, which is exactly why
 * the secret scan runs over every file before anything is read out of one.
 *
 * ## What a describe does and does not establish
 *
 * `sf sobject describe` returns only what the authenticated user can see. A
 * describe captured by a low-permission user silently omits fields, so
 * `TargetObjectContract.fields` is the field list that user could see and not
 * the object's field list. A field missing from it has not been established to
 * be absent, and nothing may read its absence as proof that the org lacks it.
 * The contract type has no slot for the capturing identity, so the binding is
 * made by hash instead: the org summary names the username, it is one of the
 * contract's artifacts, and `hashTargetContract` covers its digest.
 *
 * The same rule inside a field entry is carried by `TargetFlag`: an attribute
 * the describe does not state reads `UNKNOWN`, never `FALSE`. `unique`,
 * `externalId` and `idLookup` are three separate attributes of a Salesforce
 * field and are read separately here. Marking a field External ID does not make
 * it Unique, and it is `idLookup` that upsert matching actually requires.
 */

/** The one bundle format this reader accepts. A different string is a different layout, and is refused rather than attempted. */
export const SALESFORCE_BUNDLE_FORMAT = 'kauro-salesforce-target-bundle/1';

/** The manifest names the file set, so it cannot be one of the files it names. */
export const SALESFORCE_MANIFEST_PATH = 'manifest.json';

/** The four objects the SALESFORCE mode addresses. A bundle without all four cannot speak for the migration. */
export const SALESFORCE_REQUIRED_SOBJECTS = ['Account', 'Contact', 'Lead', 'Opportunity'] as const;

export type SalesforceArtifactKind = 'SALESFORCE_DESCRIBE' | 'SALESFORCE_ORG_SUMMARY' | 'SALESFORCE_ATTESTATION';

const ARTIFACT_KINDS: readonly SalesforceArtifactKind[] = [
  'SALESFORCE_DESCRIBE',
  'SALESFORCE_ORG_SUMMARY',
  'SALESFORCE_ATTESTATION',
];

/**
 * Caps on everything a bundle can grow: how many files, how many bytes, how
 * many fields, how many picklist values, how long one string may be. A reader
 * without them turns a hostile file into unbounded work.
 */
export interface SalesforceBundleLimits {
  readonly maxFiles: number;
  readonly maxBytesPerFile: number;
  readonly maxTotalBytes: number;
  readonly maxObjects: number;
  readonly maxFieldsPerObject: number;
  readonly maxPicklistValuesPerField: number;
  readonly maxRecordTypesPerObject: number;
  readonly maxStringLength: number;
  readonly maxJsonKeys: number;
  readonly maxPathLength: number;
  readonly maxDirectoryDepth: number;
}

export const SALESFORCE_BUNDLE_LIMITS: SalesforceBundleLimits = {
  maxFiles: 64,
  maxBytesPerFile: 8_388_608,
  maxTotalBytes: 33_554_432,
  maxObjects: 32,
  // Salesforce documents 5,000 fields per record as a Bulk API limit, which
  // bounds the largest describe an org can produce.
  maxFieldsPerObject: 5_000,
  maxPicklistValuesPerField: 5_000,
  maxRecordTypesPerObject: 1_000,
  // 131,072 characters is the documented Bulk API cap on one field value. No
  // string in a describe has a reason to be longer than a value can be.
  maxStringLength: 131_072,
  maxJsonKeys: 1_000_000,
  maxPathLength: 200,
  maxDirectoryDepth: 4,
};

/** One file of the bundle, as bytes. Bytes rather than text, because the contract records the digest of what was on disk. */
export interface SalesforceBundleFile {
  /** Bundle-relative, "/" separated. This is the name the manifest declares and the name the contract records. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

// --------------------------------------------------------------- secret refusal

/**
 * Key names that may never appear in a bundle.
 *
 * Compared against a normalised key -- lower-cased, with every non-alphanumeric
 * character removed -- by suffix, so `access_token`, `sfAccessToken` and
 * `ACCESS-TOKEN` are one name. Suffix rather than equality because a prefix is
 * the cheapest way to dress a credential up as something else, and no attribute
 * of a Salesforce describe ends in any of these.
 *
 * The key is refused whatever its value is. As of Salesforce CLI 2.136.8
 * (27 May 2026) access tokens, passwords and SFDX auth URLs are redacted from
 * the JSON output of the org and login commands, so a correct modern bundle
 * carries none of these keys at all; an older CLI, a hand edit, or
 * SF_TEMP_SHOW_SECRETS can still put one there. A reader that accepted the key
 * whenever the value looked redacted would be a reader that has to tell a
 * redaction from a token, which is the one thing it cannot do.
 */
const SECRET_KEY_SUFFIXES = [
  'accesstoken',
  'clientsecret',
  'password',
  'refreshtoken',
  'sessionid',
  'sfdxauthurl',
] as const;

interface SecretValuePattern {
  readonly kind: string;
  readonly expression: RegExp;
}

/**
 * Credential shapes recognisable from the value alone, wherever in the bundle
 * they appear. These catch a secret pasted into a file that has no business
 * carrying one, which a key-name rule cannot see.
 *
 * A bare token in an unnamed position is not recognisable, and no claim is made
 * that it would be: the closed shapes and the manifest are what keep unnamed
 * material out of the bundle in the first place.
 */
const SECRET_VALUE_PATTERNS: readonly SecretValuePattern[] = [
  { kind: 'SFDX_AUTH_URL', expression: /force:\/\// },
  { kind: 'PEM_PRIVATE_KEY', expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'OAUTH_BEARER_TOKEN', expression: /\bbearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}/i },
  // A Salesforce session id is an org id, an exclamation mark, then the token.
  // The exclamation mark is what separates it from a plain 15- or 18-character
  // org id, which is not a secret and is still returned after the redaction.
  { kind: 'SALESFORCE_SESSION_ID', expression: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-+/=]{15,}/ },
];

/**
 * Refuse a file that carries a credential.
 *
 * The scan runs over the raw text rather than over a parsed object, because a
 * file that does not parse must be refused for this too, and because parsing
 * happens after this check by design: nothing should interpret a file that
 * turns out to hold a secret.
 *
 * The message names the file and the key. It never carries the value, so an
 * operator can paste a Kauro failure into a ticket without pasting a credential
 * into it -- which is the point of refusing rather than redacting.
 */
export function assertNoSecrets(text: string, sourcePath: string): void {
  assertNoSecretsWithin(text, sourcePath, SALESFORCE_BUNDLE_LIMITS);
}

function assertNoSecretsWithin(text: string, sourcePath: string, limits: SalesforceBundleLimits): void {
  for (const token of scanJsonKeyTokens(text, sourcePath, limits)) {
    const normalized = normalizeKey(token.key);
    const matched = SECRET_KEY_SUFFIXES.find((suffix) => normalized.endsWith(suffix));
    if (matched !== undefined) {
      throw secretRefusal(sourcePath, `credential key (${matched})`, token.key, token.offset);
    }
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    const found = pattern.expression.exec(text);
    if (found !== null) {
      throw secretRefusal(sourcePath, pattern.kind, null, found.index);
    }
  }
}

function secretRefusal(sourcePath: string, kind: string, key: string | null, offset: number): MigrationError {
  const at = key === null ? '' : ` in the key "${key}"`;
  return new MigrationError(
    'TARGET_ARTIFACT_SECRET_PRESENT',
    `${sourcePath} carries a ${kind}${at} at character offset ${String(offset)}`,
    'Treat the credential as disclosed: rotate it, then re-capture the bundle with Salesforce CLI 2.136.8 or later, which redacts tokens, passwords and SFDX auth URLs from its own output. Do not edit the value out and resend the same file.',
    { sourcePath, secretKind: kind, key, characterOffset: offset },
  );
}

// ------------------------------------------------------------ JSON key scanning

interface JsonKeyToken {
  readonly key: string;
  /** Which object the key belongs to. Two keys collide only inside one object. */
  readonly frame: number;
  readonly offset: number;
}

/**
 * Every key position in a JSON text, with the object it belongs to.
 *
 * `JSON.parse` keeps the last of two identical keys and says nothing, so a
 * describe stating `"unique": true` and then `"unique": false` reads as a
 * settled fact the file never settled. Catching that needs the text, not the
 * parsed object, which is what this walks.
 *
 * It is deliberately tolerant: an unterminated string ends the scan and returns
 * what was seen. The caller that cares about well-formedness is `JSON.parse`,
 * and the caller that cares about secrets must still get an answer out of a
 * file that does not parse.
 */
function scanJsonKeyTokens(text: string, sourcePath: string, limits: SalesforceBundleLimits): JsonKeyToken[] {
  const tokens: JsonKeyToken[] = [];
  const stack: { readonly isObject: boolean; readonly id: number }[] = [];
  let nextFrame = 0;
  let index = 0;

  while (index < text.length) {
    const character = text[index] as string;
    if (character === '"') {
      const read = readJsonString(text, index);
      if (read === null) return tokens;
      let after = read.end;
      while (after < text.length && isJsonWhitespace(text[after] as string)) after += 1;
      const top = stack[stack.length - 1];
      if (text[after] === ':' && top !== undefined && top.isObject) {
        if (tokens.length >= limits.maxJsonKeys) {
          throw new MigrationError(
            'INPUT_LIMIT_EXCEEDED',
            `${sourcePath} carries more than ${String(limits.maxJsonKeys)} JSON keys`,
            'Re-capture the bundle. The Salesforce CLI does not produce a payload this large.',
            { sourcePath, limit: 'maxJsonKeys', allowed: limits.maxJsonKeys },
          );
        }
        tokens.push({ key: read.value, frame: top.id, offset: index });
      }
      index = read.end;
      continue;
    }
    if (character === '{') {
      nextFrame += 1;
      stack.push({ isObject: true, id: nextFrame });
    } else if (character === '[') {
      stack.push({ isObject: false, id: 0 });
    } else if (character === '}' || character === ']') {
      stack.pop();
    }
    index += 1;
  }
  return tokens;
}

function isJsonWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

/**
 * Read one JSON string starting at its opening quote.
 *
 * Escapes are decoded, so a key cannot be spelled around the secret-name check
 * by writing one of its letters as an escape sequence.
 */
function readJsonString(text: string, start: number): { value: string; end: number } | null {
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const character = text[index] as string;
    if (character === '"') return { value, end: index + 1 };
    if (character !== '\\') {
      value += character;
      index += 1;
      continue;
    }
    const escaped = text[index + 1];
    if (escaped === undefined) return null;
    if (escaped === 'u') {
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    value += SIMPLE_ESCAPES[escaped] ?? escaped;
    index += 2;
  }
  return null;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Lower-cased with every non-alphanumeric character dropped, so key discovery is case- and whitespace-insensitive. The original text is what any error quotes. */
function normalizeKey(key: string): string {
  return key.replace(/[^0-9A-Za-z]/g, '').toLowerCase();
}

// ------------------------------------------------------------------ JSON access

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeOf(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    default:
      return 'an object';
  }
}

function invalid(sourcePath: string, message: string, remedy: string, details: JsonObject = {}): MigrationError {
  return new MigrationError('TARGET_CONTRACT_INVALID', `${sourcePath} ${message}`, remedy, {
    sourcePath,
    ...details,
  });
}

const RECAPTURE =
  'Re-capture the bundle with the documented Salesforce CLI commands, or correct the file the message names.';

interface ReadContext {
  readonly sourcePath: string;
  /** Where in the file, for the message: `field "Email"`, `record type 3`, `the describe`. */
  readonly where: string;
  readonly limits: SalesforceBundleLimits;
}

interface KeyMatch {
  /** The key exactly as the file spelled it, so an error quotes what an operator will find when they open the file. */
  readonly key: string;
  readonly value: JsonValue;
}

/**
 * Find one key by its normalised name.
 *
 * Two keys that normalise to the same name are refused rather than resolved. A
 * file carrying both `"unique"` and `"Unique"` does not state one fact twice;
 * it states two facts the reader has no rule for ordering, and picking either
 * would be a coin toss recorded as evidence.
 */
function pick(source: JsonObject, wanted: string, context: ReadContext): KeyMatch | null {
  const target = normalizeKey(wanted);
  const matches: KeyMatch[] = [];
  for (const [key, value] of Object.entries(source).sort((a, b) => compareCodeUnits(a[0], b[0]))) {
    if (normalizeKey(key) === target) matches.push({ key, value });
  }
  const first = matches[0];
  if (first === undefined) return null;
  if (matches.length > 1) {
    throw invalid(
      context.sourcePath,
      `${context.where} carries ${String(matches.length)} keys that all read as "${wanted}": ${matches
        .map((match) => JSON.stringify(match.key))
        .join(', ')}`,
      'Remove the duplicate key. The reader will not choose between two spellings of one attribute.',
      { where: context.where, key: wanted },
    );
  }
  return first;
}

function readString(source: JsonObject, key: string, context: ReadContext): string | null {
  const found = pick(source, key, context);
  if (found === null || found.value === null) return null;
  if (typeof found.value !== 'string') {
    throw invalid(
      context.sourcePath,
      `${context.where} states "${found.key}" as ${shapeOf(found.value)}; a string is required`,
      RECAPTURE,
      { where: context.where, key: found.key },
    );
  }
  if (found.value.length > context.limits.maxStringLength) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${context.sourcePath} ${context.where} states "${found.key}" as ${String(found.value.length)} characters, above the limit of ${String(context.limits.maxStringLength)}`,
      'Re-capture the bundle. A describe does not carry a string this long.',
      {
        sourcePath: context.sourcePath,
        limit: 'maxStringLength',
        allowed: context.limits.maxStringLength,
        actual: found.value.length,
      },
    );
  }
  return found.value;
}

function readRequiredString(source: JsonObject, key: string, context: ReadContext): string {
  const value = readString(source, key, context);
  if (value === null) {
    throw invalid(context.sourcePath, `${context.where} does not state "${key}"`, RECAPTURE, {
      where: context.where,
      key,
    });
  }
  return value;
}

function readNonEmptyString(source: JsonObject, key: string, context: ReadContext): string {
  const value = readRequiredString(source, key, context);
  if (value.length === 0) {
    throw invalid(context.sourcePath, `${context.where} states "${key}" as an empty string`, RECAPTURE, {
      where: context.where,
      key,
    });
  }
  return value;
}

/**
 * A boolean attribute as a tri-state.
 *
 * Absent and `null` both read `UNKNOWN`, because a describe that did not state
 * the attribute did not state it false. Anything that is not a JSON boolean --
 * `"true"`, `1`, `"FALSE"` -- is refused rather than coerced: reading a string
 * as a boolean would let a hostile file assert `unique` with a value Salesforce
 * never writes.
 */
function readFlag(source: JsonObject, key: string, context: ReadContext): TargetFlag {
  const found = pick(source, key, context);
  if (found === null || found.value === null) return 'UNKNOWN';
  if (typeof found.value !== 'boolean') {
    throw invalid(
      context.sourcePath,
      `${context.where} states "${found.key}" as ${shapeOf(found.value)}; a describe states it as a boolean`,
      RECAPTURE,
      { where: context.where, key: found.key },
    );
  }
  return found.value ? 'TRUE' : 'FALSE';
}

/** A boolean the contract has no `UNKNOWN` for. Absence is refused rather than guessed, because there would be nowhere to record the guess. */
function readRequiredBoolean(source: JsonObject, key: string, context: ReadContext): boolean {
  const found = pick(source, key, context);
  if (found === null || found.value === null) {
    throw invalid(
      context.sourcePath,
      `${context.where} does not state "${key}", and the contract has no way to record it as unestablished`,
      RECAPTURE,
      { where: context.where, key },
    );
  }
  if (typeof found.value !== 'boolean') {
    throw invalid(
      context.sourcePath,
      `${context.where} states "${found.key}" as ${shapeOf(found.value)}; a describe states it as a boolean`,
      RECAPTURE,
      { where: context.where, key: found.key },
    );
  }
  return found.value;
}

function readInteger(source: JsonObject, key: string, context: ReadContext): number | null {
  const found = pick(source, key, context);
  if (found === null || found.value === null) return null;
  if (typeof found.value !== 'number' || !Number.isSafeInteger(found.value) || found.value < 0) {
    throw invalid(
      context.sourcePath,
      `${context.where} states "${found.key}" as ${shapeOf(found.value)}; a describe states it as a non-negative whole number`,
      RECAPTURE,
      { where: context.where, key: found.key },
    );
  }
  return found.value;
}

function readArray(source: JsonObject, key: string, context: ReadContext): JsonValue[] | null {
  const found = pick(source, key, context);
  if (found === null || found.value === null) return null;
  if (!Array.isArray(found.value)) {
    throw invalid(
      context.sourcePath,
      `${context.where} states "${found.key}" as ${shapeOf(found.value)}; an array is required`,
      RECAPTURE,
      { where: context.where, key: found.key },
    );
  }
  return found.value;
}

function readObjectAt(value: JsonValue, context: ReadContext): JsonObject {
  if (!isJsonObject(value)) {
    throw invalid(context.sourcePath, `${context.where} is ${shapeOf(value)}; an object is required`, RECAPTURE, {
      where: context.where,
    });
  }
  return value;
}

/** A closed shape: every key the schema does not name is refused, quoted as the file spelled it. */
function assertClosedKeys(source: JsonObject, allowed: readonly string[], context: ReadContext): void {
  const permitted = new Set(allowed.map(normalizeKey));
  for (const key of Object.keys(source).sort(compareCodeUnits)) {
    if (!permitted.has(normalizeKey(key))) {
      throw invalid(
        context.sourcePath,
        `${context.where} carries the key "${key}", which this shape does not define`,
        'Remove the key. This file has a closed shape so that nothing can be carried into it beside the facts it exists to state.',
        { where: context.where, key },
      );
    }
  }
}

/**
 * Parse a bundle file as a JSON object.
 *
 * The parser's own message is not repeated: it quotes the offending input, and
 * a file that failed to parse is exactly the file whose contents must not end
 * up in a log.
 */
function parseJsonDocument(text: string, sourcePath: string, limits: SalesforceBundleLimits): JsonObject {
  let value: JsonValue;
  try {
    value = parseJson(text);
  } catch {
    throw invalid(sourcePath, 'is not valid JSON', RECAPTURE);
  }
  if (!isJsonObject(value)) {
    throw invalid(sourcePath, `is ${shapeOf(value)} at the top level; a JSON object is required`, RECAPTURE);
  }
  assertNoDuplicateJsonKeys(text, sourcePath, limits);
  return value;
}

function assertNoDuplicateJsonKeys(text: string, sourcePath: string, limits: SalesforceBundleLimits): void {
  const seen = new Set<string>();
  for (const token of scanJsonKeyTokens(text, sourcePath, limits)) {
    const identity = `${String(token.frame)} ${token.key}`;
    if (seen.has(identity)) {
      throw invalid(
        sourcePath,
        `states the key "${token.key}" twice in one object (character offset ${String(token.offset)})`,
        'Remove the duplicate key. Parsing keeps the last one silently, so the file states a fact it never settled.',
        { key: token.key, characterOffset: token.offset },
      );
    }
    seen.add(identity);
  }
}

// ------------------------------------------------------------- describe reading

/**
 * The describe payload, from either shape the CLI produces.
 *
 * With `--json` the payload is `{ "status": 0, "result": <describe>, "warnings": [] }`;
 * without it the describe is emitted unwrapped. Both are accepted. A file
 * carrying both -- a `result` alongside a top-level `name` or `fields` -- is
 * refused, because two describes in one file are two answers and the reader has
 * no rule saying which one the org gave.
 */
function unwrapCliPayload(root: JsonObject, context: ReadContext): JsonObject {
  const wrapped = pick(root, 'result', context);
  const direct = pick(root, 'fields', context) ?? pick(root, 'name', context);

  if (wrapped !== null && direct !== null) {
    throw invalid(
      context.sourcePath,
      `carries both the "${wrapped.key}" envelope and a top-level "${direct.key}"; it states two payloads and the reader will not choose between them`,
      RECAPTURE,
    );
  }
  if (wrapped === null) {
    if (direct === null) {
      throw invalid(
        context.sourcePath,
        'is neither a Salesforce CLI --json envelope nor a bare describe: it carries no "result", and no "name" or "fields"',
        RECAPTURE,
      );
    }
    return root;
  }
  assertCommandSucceeded(root, context);
  return readObjectAt(wrapped.value, { ...context, where: `the "${wrapped.key}" envelope` });
}

/** A non-zero `status` means the command failed and `result` is whatever it failed with. Reading that as a describe would build a contract out of an error. */
function assertCommandSucceeded(root: JsonObject, context: ReadContext): void {
  const status = pick(root, 'status', context);
  if (status !== null && typeof status.value === 'number' && status.value !== 0) {
    throw invalid(
      context.sourcePath,
      `reports status ${String(status.value)}; the command that wrote it failed`,
      'Run the command again and check that it succeeded before putting its output in the bundle.',
      { status: status.value },
    );
  }
}

/**
 * One `sf sobject describe` payload as a target object contract.
 *
 * Every fact here is `ARTIFACT` evidence: it is what the instance itself
 * emitted. Nothing in this function supplies a value the payload did not carry.
 */
export function parseSalesforceDescribe(
  text: string,
  sourcePath: string,
  limits: SalesforceBundleLimits = SALESFORCE_BUNDLE_LIMITS,
): TargetObjectContract {
  assertNoSecretsWithin(text, sourcePath, limits);
  const context: ReadContext = { sourcePath, where: 'the describe', limits };
  const describe = unwrapCliPayload(parseJsonDocument(text, sourcePath, limits), context);

  const apiName = readNonEmptyString(describe, 'name', context);
  const label = readRequiredString(describe, 'label', context);

  const rawFields = readArray(describe, 'fields', context);
  if (rawFields === null) {
    throw invalid(
      sourcePath,
      `describes "${apiName}" without a "fields" array; there is no field list to speak for the object`,
      RECAPTURE,
      { apiName },
    );
  }
  if (rawFields.length > limits.maxFieldsPerObject) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${sourcePath} describes ${String(rawFields.length)} fields on ${apiName}, above the limit of ${String(limits.maxFieldsPerObject)}`,
      'Re-capture the bundle. Salesforce documents 5,000 fields per record as the ceiling.',
      { sourcePath, limit: 'maxFieldsPerObject', allowed: limits.maxFieldsPerObject, actual: rawFields.length },
    );
  }

  const fields: TargetFieldContract[] = [];
  const seenFields = new Set<string>();
  rawFields.forEach((entry, index) => {
    const field = readField(entry, index, sourcePath, limits);
    if (seenFields.has(field.apiName)) {
      throw invalid(
        sourcePath,
        `describes the field "${field.apiName}" on ${apiName} twice`,
        'Re-capture the bundle. One field stated twice is two answers about one field.',
        { apiName, field: field.apiName },
      );
    }
    seenFields.add(field.apiName);
    fields.push(field);
  });

  return {
    apiName,
    label,
    createable: readFlag(describe, 'createable', context),
    updateable: readFlag(describe, 'updateable', context),
    // Sorted by API name. The contract is a set of facts addressed by name, and
    // the order the CLI happened to emit them in is not one of the facts, so two
    // captures of an unchanged org produce the same contract hash.
    fields: [...fields].sort((a, b) => compareCodeUnits(a.apiName, b.apiName)),
    recordTypes: readRecordTypes(describe, apiName, sourcePath, limits),
  };
}

function readField(
  entry: JsonValue,
  index: number,
  sourcePath: string,
  limits: SalesforceBundleLimits,
): TargetFieldContract {
  const positional: ReadContext = { sourcePath, where: `field ${String(index)}`, limits };
  const source = readObjectAt(entry, positional);
  const apiName = readNonEmptyString(source, 'name', positional);
  const context: ReadContext = { sourcePath, where: `field "${apiName}"`, limits };

  const type = readNonEmptyString(source, 'type', context);
  const relationshipName = readString(source, 'relationshipName', context);

  return {
    apiName,
    label: readRequiredString(source, 'label', context),
    // The instance's own type token, verbatim. Mapping it onto a type of ours
    // here would put this reader's opinion where the org's answer belongs.
    type,
    createable: readFlag(source, 'createable', context),
    updateable: readFlag(source, 'updateable', context),
    nillable: readFlag(source, 'nillable', context),
    length: readInteger(source, 'length', context),
    precision: readInteger(source, 'precision', context),
    scale: readInteger(source, 'scale', context),
    // Three separate attributes, read separately. Salesforce documents them as
    // separate; an External ID that is not Unique can match two records on
    // upsert, and idLookup is what upsert matching actually requires.
    unique: readFlag(source, 'unique', context),
    externalId: readFlag(source, 'externalId', context),
    idLookup: readFlag(source, 'idLookup', context),
    // A calculated field is a formula and an autoNumber field is generated by
    // the org. Both are read-only, and neither may appear in a write payload.
    calculated: readFlag(source, 'calculated', context),
    autoNumber: readFlag(source, 'autoNumber', context),
    defaultedOnCreate: readFlag(source, 'defaultedOnCreate', context),
    restrictedPicklist: readFlag(source, 'restrictedPicklist', context),
    picklistValues: readPicklistValues(source, context),
    referenceTo: readReferenceTo(source, type, relationshipName, context),
    relationshipName,
    evidence: 'ARTIFACT',
  };
}

/**
 * What a lookup points at.
 *
 * An absent `referenceTo` is refused only where the same entry already says the
 * field is a lookup -- its type is `reference`, or it carries a relationship
 * name. There, the absence hides the object the field points at. Anywhere else
 * the empty array is the honest reading of a field that references nothing.
 */
function readReferenceTo(
  source: JsonObject,
  type: string,
  relationshipName: string | null,
  context: ReadContext,
): readonly string[] {
  const raw = readArray(source, 'referenceTo', context);
  if (raw === null) {
    if (type === 'reference' || (relationshipName !== null && relationshipName.length > 0)) {
      throw invalid(
        context.sourcePath,
        `${context.where} is a lookup but does not state "referenceTo"; the object it points at is not established`,
        RECAPTURE,
        { where: context.where },
      );
    }
    return [];
  }
  return raw.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw invalid(
        context.sourcePath,
        `${context.where} states "referenceTo" entry ${String(index)} as ${shapeOf(item)}; a non-empty string is required`,
        RECAPTURE,
        { where: context.where },
      );
    }
    return item;
  });
}

/**
 * Picklist values in the order the org stated them.
 *
 * Unlike fields these are not sorted: the order is the order the org presents
 * the values in, which is a fact about the org that re-ordering would lose. It
 * is deterministic either way, being the order in the bytes.
 *
 * `label` is required as a string. The contract type has no way to say a label
 * was not stated, and substituting the value for a missing label would put text
 * in the contract that the org never produced.
 */
function readPicklistValues(source: JsonObject, context: ReadContext): readonly TargetPicklistValue[] {
  const raw = readArray(source, 'picklistValues', context);
  if (raw === null) return [];
  if (raw.length > context.limits.maxPicklistValuesPerField) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${context.sourcePath} ${context.where} states ${String(raw.length)} picklist values, above the limit of ${String(context.limits.maxPicklistValuesPerField)}`,
      'Re-capture the bundle, or raise the limit if a picklist this large is expected.',
      {
        sourcePath: context.sourcePath,
        limit: 'maxPicklistValuesPerField',
        allowed: context.limits.maxPicklistValuesPerField,
        actual: raw.length,
      },
    );
  }
  const values: TargetPicklistValue[] = [];
  raw.forEach((entry, index) => {
    const optionContext: ReadContext = { ...context, where: `${context.where} picklist value ${String(index)}` };
    const option = readObjectAt(entry, optionContext);
    // A repeated value is not a corrupt capture.
    //
    // This used to refuse a describe that stated the same picklist value twice,
    // on the reasoning that a value set is a set. Reading a real org showed the
    // reasoning was wrong: `BillingStateCode` states "AG" twice, because a
    // dependent picklist repeats a code under each parent it is valid for and
    // tells them apart by `validFor`, not by the code. Salesforce's own State
    // and Country picklists are full of such repeats.
    //
    // So the entries are recorded as the org states them. What the contract must
    // never do is invent a value or drop one, and de-duplicating here would drop
    // one — with the wrong label, under the wrong parent, silently.
    const value = readNonEmptyString(option, 'value', optionContext);
    values.push({
      value,
      label: readRequiredString(option, 'label', optionContext),
      // `active` decides whether a value may be delivered at all, so an
      // unstated `active` must never read as usable.
      active: readRequiredBoolean(option, 'active', optionContext),
      defaultValue: readRequiredBoolean(option, 'defaultValue', optionContext),
    });
  });
  return values;
}

/**
 * Record types, keyed by developer name.
 *
 * `developerName` is the stable key. `name` is a translatable label, carried for
 * people to read and never used to address a record type, and `recordTypeId`
 * names this org's record type and nobody else's.
 */
function readRecordTypes(
  describe: JsonObject,
  apiName: string,
  sourcePath: string,
  limits: SalesforceBundleLimits,
): readonly TargetRecordType[] {
  const context: ReadContext = { sourcePath, where: `the describe of "${apiName}"`, limits };
  const raw = readArray(describe, 'recordTypeInfos', context);
  if (raw === null) return [];
  if (raw.length > limits.maxRecordTypesPerObject) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${sourcePath} states ${String(raw.length)} record types on ${apiName}, above the limit of ${String(limits.maxRecordTypesPerObject)}`,
      'Re-capture the bundle, or raise the limit if this is expected.',
      { sourcePath, limit: 'maxRecordTypesPerObject', allowed: limits.maxRecordTypesPerObject, actual: raw.length },
    );
  }
  const recordTypes: TargetRecordType[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const positional: ReadContext = { sourcePath, where: `record type ${String(index)} of ${apiName}`, limits };
    const source = readObjectAt(entry, positional);
    const developerName = readNonEmptyString(source, 'developerName', positional);
    const named: ReadContext = { sourcePath, where: `record type "${developerName}" of ${apiName}`, limits };
    if (seen.has(developerName)) {
      throw invalid(sourcePath, `states the record type "${developerName}" on ${apiName} twice`, RECAPTURE, {
        apiName,
        developerName,
      });
    }
    seen.add(developerName);
    recordTypes.push({
      developerName,
      name: readRequiredString(source, 'name', named),
      recordTypeId: readNonEmptyString(source, 'recordTypeId', named),
      master: readRequiredBoolean(source, 'master', named),
      available: readRequiredBoolean(source, 'available', named),
    });
  });
  return [...recordTypes].sort((a, b) => compareCodeUnits(a.developerName, b.developerName));
}

// ---------------------------------------------------------------- bundle paths

/** A path segment naming one plain file or directory. Anything else is refused rather than normalised. */
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A bundle-relative path this reader is willing to name.
 *
 * The judgement is on the text, not on what the filesystem would do with it: a
 * path that has to be resolved before it can be judged has already been trusted
 * once. A `..` segment, a leading separator, a drive letter and a backslash are
 * all refused outright, so no path here can address anything outside the bundle
 * on any platform.
 */
function assertBundlePath(path: string, label: string, limits: SalesforceBundleLimits): void {
  const refuse = (reason: string): never => {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `${label} ${JSON.stringify(path)} ${reason}`,
      'Use a plain relative path inside the bundle, such as "describe/Account.json".',
      { path, reason },
    );
  };
  if (path.length === 0) refuse('is empty');
  if (path.length > limits.maxPathLength) refuse(`is longer than ${String(limits.maxPathLength)} characters`);
  if (path.includes('\\')) refuse('uses a backslash; bundle paths are "/" separated');
  if (path.startsWith('/')) refuse('is absolute');
  if (/^[A-Za-z]:/.test(path)) refuse('names a drive');
  if (path.endsWith('/')) refuse('names a directory rather than a file');
  for (const segment of path.split('/')) {
    if (segment === '..') refuse('escapes the bundle root');
    if (segment === '.') refuse('carries a "." segment');
    if (segment.length === 0) refuse('carries an empty path segment');
    if (!PATH_SEGMENT.test(segment)) {
      refuse(`carries the segment ${JSON.stringify(segment)}, which is not a plain file name`);
    }
  }
}

// ---------------------------------------------------------------- the manifest

interface ManifestEntry {
  readonly path: string;
  readonly kind: SalesforceArtifactKind;
  readonly sobject: string | null;
}

const MANIFEST_KEYS = ['bundleFormat', 'files'] as const;
const MANIFEST_ENTRY_KEYS = ['path', 'kind', 'sobject'] as const;

/** Salesforce API names: a letter, then letters, digits and underscores. The `__c` and `__r` suffixes are covered by that. */
const SOBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

function readManifest(text: string, limits: SalesforceBundleLimits): readonly ManifestEntry[] {
  const sourcePath = SALESFORCE_MANIFEST_PATH;
  const context: ReadContext = { sourcePath, where: 'the manifest', limits };
  const root = parseJsonDocument(text, sourcePath, limits);
  assertClosedKeys(root, MANIFEST_KEYS, context);

  const format = readNonEmptyString(root, 'bundleFormat', context);
  if (format !== SALESFORCE_BUNDLE_FORMAT) {
    throw invalid(
      sourcePath,
      `declares bundleFormat ${JSON.stringify(format)}; this reader reads ${JSON.stringify(SALESFORCE_BUNDLE_FORMAT)}`,
      'Capture the bundle with the runbook that matches this core version.',
      { declared: format, expected: SALESFORCE_BUNDLE_FORMAT },
    );
  }

  const rawFiles = readArray(root, 'files', context);
  if (rawFiles === null) {
    throw invalid(sourcePath, 'does not state a "files" array', RECAPTURE);
  }
  if (rawFiles.length > limits.maxFiles) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${sourcePath} declares ${String(rawFiles.length)} files, above the limit of ${String(limits.maxFiles)}`,
      'Raise the limit if a bundle this large is expected, or split the capture.',
      { sourcePath, limit: 'maxFiles', allowed: limits.maxFiles, actual: rawFiles.length },
    );
  }

  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  rawFiles.forEach((entry, index) => {
    const entryContext: ReadContext = { sourcePath, where: `manifest entry ${String(index)}`, limits };
    const source = readObjectAt(entry, entryContext);
    assertClosedKeys(source, MANIFEST_ENTRY_KEYS, entryContext);

    const path = readNonEmptyString(source, 'path', entryContext);
    assertBundlePath(path, `${sourcePath} entry ${String(index)} path`, limits);
    if (path === SALESFORCE_MANIFEST_PATH) {
      throw invalid(
        sourcePath,
        'declares itself as one of its own files; the manifest names the set and cannot be a member of it',
        'Remove the manifest.json entry from the files array.',
      );
    }
    if (seen.has(path)) {
      throw new MigrationError(
        'INPUT_DUPLICATE_FILE',
        `${sourcePath} declares "${path}" twice`,
        'Declare each file once. Two entries for one path are two claims about the same bytes.',
        { sourcePath, path },
      );
    }
    seen.add(path);

    const kindText = readNonEmptyString(source, 'kind', entryContext);
    const kind = ARTIFACT_KINDS.find((candidate) => candidate === kindText);
    if (kind === undefined) {
      throw invalid(
        sourcePath,
        `entry ${String(index)} declares kind ${JSON.stringify(kindText)}; the kinds are ${ARTIFACT_KINDS.join(', ')}`,
        'Correct the kind. An unknown kind is a file this reader has no rule for.',
        { path, kind: kindText },
      );
    }

    const sobject = readString(source, 'sobject', entryContext);
    if (kind === 'SALESFORCE_DESCRIBE') {
      if (sobject === null) {
        throw invalid(sourcePath, `entry for "${path}" is a describe but does not name its sobject`, RECAPTURE, {
          path,
        });
      }
      if (!SOBJECT_NAME.test(sobject)) {
        throw invalid(
          sourcePath,
          `entry for "${path}" names the sobject ${JSON.stringify(sobject)}, which is not a Salesforce API name`,
          RECAPTURE,
          { path, sobject },
        );
      }
    } else if (sobject !== null) {
      throw invalid(
        sourcePath,
        `entry for "${path}" is ${kind} but names an sobject; only a describe describes one object`,
        'Remove the sobject key from the entry.',
        { path, kind },
      );
    }

    entries.push({ path, kind, sobject });
  });

  return [...entries].sort((a, b) => compareCodeUnits(a.path, b.path));
}

// ------------------------------------------------------ org summary, attestation

const ATTESTATION_KEYS = ['capturedAt', 'capturedBy', 'cliVersion'] as const;

/** A UTC instant, spelled one way. Written as a pattern rather than handed to the built-in date parser, which accepts far more than this and normalises what it accepts. */
const CAPTURED_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

function readAttestation(text: string, sourcePath: string, limits: SalesforceBundleLimits): string {
  const context: ReadContext = { sourcePath, where: 'the attestation', limits };
  const root = parseJsonDocument(text, sourcePath, limits);
  assertClosedKeys(root, ATTESTATION_KEYS, context);

  const capturedBy = readNonEmptyString(root, 'capturedBy', context);
  if (capturedBy.length > 200) {
    throw invalid(sourcePath, 'states a capturedBy longer than 200 characters', RECAPTURE);
  }
  const cliVersion = readNonEmptyString(root, 'cliVersion', context);
  if (!/^\d+\.\d+\.\d+$/.test(cliVersion)) {
    throw invalid(
      sourcePath,
      `states cliVersion ${JSON.stringify(cliVersion)}, which is not a three-part version`,
      'Record the version "sf --version" printed when the bundle was captured.',
      { cliVersion },
    );
  }

  const capturedAt = readNonEmptyString(root, 'capturedAt', context);
  const parts = CAPTURED_AT.exec(capturedAt);
  if (parts === null) {
    throw invalid(
      sourcePath,
      `states capturedAt ${JSON.stringify(capturedAt)}; the form is YYYY-MM-DDTHH:MM:SSZ`,
      'State the capture time as a UTC instant in that exact form.',
      { capturedAt },
    );
  }
  if (!isRealUtcInstant(parts)) {
    throw invalid(
      sourcePath,
      `states capturedAt ${JSON.stringify(capturedAt)}, which is not a real instant`,
      'State the capture time as a UTC instant that exists.',
      { capturedAt },
    );
  }
  return capturedAt;
}

/** Calendar arithmetic done here rather than through the built-in date parser, which both parses leniently and reads the host time zone. */
function isRealUtcInstant(parts: RegExpExecArray): boolean {
  const numberAt = (index: number): number => Number.parseInt(parts[index] as string, 10);
  const year = numberAt(1);
  const month = numberAt(2);
  const day = numberAt(3);
  if (month < 1 || month > 12) return false;
  if (numberAt(4) > 23 || numberAt(5) > 59 || numberAt(6) > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (lengths[month - 1] as number);
}

/** Salesforce ids are 15 or 18 alphanumeric characters. An org id is not a secret and is still returned by the CLI after the 2.136.8 redaction. */
const SALESFORCE_ID = /^[A-Za-z0-9]{15}$|^[A-Za-z0-9]{18}$/;

/**
 * Which instance the contract speaks for.
 *
 * The org summary is the CLI's own output, so the identity is `ARTIFACT`
 * evidence rather than something the agency stated.
 *
 * The org id is discovered under either "orgId" or "id". The documentation this
 * repository holds establishes that the org display command returns the org id,
 * the instance URL and the username, and that none of the three is redacted; it
 * does not establish which of those two spellings the JSON payload uses. Rather
 * than guess, both are discovered, a payload carrying both with different values
 * is refused, and a payload carrying neither is refused.
 */
function readOrgSummary(text: string, sourcePath: string, limits: SalesforceBundleLimits): TargetInstanceIdentity {
  const context: ReadContext = { sourcePath, where: 'the org summary', limits };
  const summary = unwrapOrgSummary(parseJsonDocument(text, sourcePath, limits), context);

  const stated: string[] = [];
  for (const key of ['orgId', 'id']) {
    const value = readString(summary, key, context);
    if (value !== null) stated.push(value);
  }
  const first = stated[0];
  if (first === undefined) {
    throw invalid(sourcePath, 'states no org id under either "orgId" or "id"', RECAPTURE);
  }
  if (new Set(stated).size > 1) {
    throw invalid(
      sourcePath,
      'states "orgId" and "id" as different values; the org this contract speaks for is not established',
      RECAPTURE,
    );
  }
  if (!SALESFORCE_ID.test(first)) {
    throw invalid(
      sourcePath,
      `states the org id as ${JSON.stringify(first)}, which is not a 15- or 18-character Salesforce id`,
      RECAPTURE,
    );
  }

  const instanceUrl = readNonEmptyString(summary, 'instanceUrl', context);
  if (!instanceUrl.startsWith('https://') || /\s/.test(instanceUrl)) {
    throw invalid(
      sourcePath,
      `states the instance URL as ${JSON.stringify(instanceUrl)}; a Salesforce instance URL is an https URL`,
      RECAPTURE,
    );
  }

  // The username is not carried in the contract, which has no slot for it. It is
  // required all the same: a describe shows only what its user could see, and
  // this is the artifact that names that user. Its digest is in artifacts[], so
  // the contract's field lists stay attributable to one identity.
  const username = readNonEmptyString(summary, 'username', context);
  if (/\s/.test(username)) {
    throw invalid(sourcePath, `states the username as ${JSON.stringify(username)}, which carries whitespace`, RECAPTURE);
  }

  return { mode: 'SALESFORCE', instanceId: first, instanceLabel: instanceUrl, evidence: 'ARTIFACT' };
}

function unwrapOrgSummary(root: JsonObject, context: ReadContext): JsonObject {
  const wrapped = pick(root, 'result', context);
  const direct = pick(root, 'instanceUrl', context) ?? pick(root, 'username', context);
  if (wrapped !== null && direct !== null) {
    throw invalid(
      context.sourcePath,
      `carries both the "${wrapped.key}" envelope and a top-level "${direct.key}"; it states two payloads and the reader will not choose between them`,
      RECAPTURE,
    );
  }
  if (wrapped === null) {
    if (direct === null) {
      throw invalid(context.sourcePath, 'is neither a Salesforce CLI --json envelope nor a bare org summary', RECAPTURE);
    }
    return root;
  }
  assertCommandSucceeded(root, context);
  return readObjectAt(wrapped.value, { ...context, where: `the "${wrapped.key}" envelope` });
}

// ------------------------------------------------------------ the whole bundle

interface LoadedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly sha256: string;
}

/**
 * A target contract for one Salesforce org, built from the bundle bytes and
 * nothing else.
 *
 * The order is deliberate. Sizes are capped, then paths are judged, then every
 * file is scanned for a credential, and only then is anything interpreted. A
 * reader that parsed first would already have read a token into memory by the
 * time it decided to refuse one.
 *
 * The files are sorted by path before any of it, so the first refusal is the
 * same refusal on every platform.
 */
export function buildSalesforceTargetContract(
  files: readonly SalesforceBundleFile[],
  limits: SalesforceBundleLimits = SALESFORCE_BUNDLE_LIMITS,
): TargetContract {
  if (files.length > limits.maxFiles) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `the bundle holds ${String(files.length)} files, above the limit of ${String(limits.maxFiles)}`,
      'Raise the limit if a bundle this large is expected, or split the capture.',
      { limit: 'maxFiles', allowed: limits.maxFiles, actual: files.length },
    );
  }

  const ordered = [...files].sort((a, b) => compareCodeUnits(a.path, b.path));
  const loaded: LoadedFile[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  for (const file of ordered) {
    assertBundlePath(file.path, 'the bundle path', limits);
    if (seenPaths.has(file.path)) {
      throw new MigrationError(
        'INPUT_DUPLICATE_FILE',
        `the bundle holds "${file.path}" twice`,
        'Supply each bundle file once.',
        { path: file.path },
      );
    }
    seenPaths.add(file.path);

    if (file.bytes.length > limits.maxBytesPerFile) {
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `${file.path} is ${String(file.bytes.length)} bytes, above the per-file limit of ${String(limits.maxBytesPerFile)}`,
        'Raise the limit if a file this large is expected, or re-capture the bundle.',
        { path: file.path, limit: 'maxBytesPerFile', allowed: limits.maxBytesPerFile, actual: file.bytes.length },
      );
    }
    totalBytes += file.bytes.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `the bundle is more than ${String(limits.maxTotalBytes)} bytes`,
        'Raise the limit if a bundle this large is expected, or split the capture.',
        { limit: 'maxTotalBytes', allowed: limits.maxTotalBytes, actual: totalBytes },
      );
    }

    loaded.push({
      path: file.path,
      bytes: file.bytes,
      text: decodeSource(file.bytes, null, file.path).text,
      sha256: sha256Hex(file.bytes),
    });
  }

  for (const file of loaded) assertNoSecretsWithin(file.text, file.path, limits);

  const manifestFile = loaded.find((file) => file.path === SALESFORCE_MANIFEST_PATH);
  if (manifestFile === undefined) {
    throw new MigrationError(
      'INPUT_NOT_FOUND',
      `the bundle carries no ${SALESFORCE_MANIFEST_PATH}`,
      'Capture the bundle with the documented runbook. The manifest is what makes the file set closed.',
      { path: SALESFORCE_MANIFEST_PATH },
    );
  }

  const entries = readManifest(manifestFile.text, limits);
  const byPath = new Map(loaded.map((file) => [file.path, file]));

  // Both directions. An undeclared file is how something gets in beside the
  // artifacts; a declared file that is missing is how a bundle quietly becomes a
  // smaller one.
  for (const file of loaded) {
    if (file.path === SALESFORCE_MANIFEST_PATH) continue;
    if (!entries.some((entry) => entry.path === file.path)) {
      throw invalid(
        file.path,
        `is in the bundle but is not declared in ${SALESFORCE_MANIFEST_PATH}`,
        'Declare the file in the manifest, or remove it from the bundle. The manifest is the closed set.',
      );
    }
  }
  for (const entry of entries) {
    if (!byPath.has(entry.path)) {
      throw new MigrationError(
        'INPUT_NOT_FOUND',
        `${SALESFORCE_MANIFEST_PATH} declares "${entry.path}", which is not in the bundle`,
        'Add the missing file, or remove its manifest entry.',
        { path: entry.path },
      );
    }
  }

  const summaries = entries.filter((entry) => entry.kind === 'SALESFORCE_ORG_SUMMARY');
  const attestations = entries.filter((entry) => entry.kind === 'SALESFORCE_ATTESTATION');
  const describes = entries.filter((entry) => entry.kind === 'SALESFORCE_DESCRIBE');
  const summaryEntry = exactlyOne(summaries, 'SALESFORCE_ORG_SUMMARY');
  const attestationEntry = exactlyOne(attestations, 'SALESFORCE_ATTESTATION');

  if (describes.length > limits.maxObjects) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `the bundle declares ${String(describes.length)} describes, above the limit of ${String(limits.maxObjects)}`,
      'Raise the limit if this is expected, or capture fewer objects.',
      { limit: 'maxObjects', allowed: limits.maxObjects, actual: describes.length },
    );
  }

  const objects: TargetObjectContract[] = [];
  const seenObjects = new Set<string>();
  for (const entry of describes) {
    const file = byPath.get(entry.path) as LoadedFile;
    const object = parseSalesforceDescribe(file.text, entry.path, limits);
    if (object.apiName !== entry.sobject) {
      throw invalid(
        entry.path,
        `describes "${object.apiName}" but ${SALESFORCE_MANIFEST_PATH} declares it as "${String(entry.sobject)}"`,
        'Correct the manifest or re-capture the describe. Believing either one over the other would be a guess.',
        { declared: entry.sobject, described: object.apiName },
      );
    }
    if (seenObjects.has(object.apiName)) {
      throw new MigrationError(
        'INPUT_DUPLICATE_FILE',
        `the bundle describes "${object.apiName}" more than once`,
        'Capture one describe per object. Two describes of one object are two answers.',
        { sobject: object.apiName },
      );
    }
    seenObjects.add(object.apiName);
    objects.push(object);
  }

  for (const required of SALESFORCE_REQUIRED_SOBJECTS) {
    if (!seenObjects.has(required)) {
      throw new MigrationError(
        'INPUT_NOT_FOUND',
        `the bundle carries no describe for ${required}`,
        `The SALESFORCE mode addresses ${SALESFORCE_REQUIRED_SOBJECTS.join(', ')}, so a contract without all four cannot speak for the migration. Capture the missing describe.`,
        { sobject: required },
      );
    }
  }

  const instance = readOrgSummary((byPath.get(summaryEntry.path) as LoadedFile).text, summaryEntry.path, limits);
  const capturedAt = readAttestation(
    (byPath.get(attestationEntry.path) as LoadedFile).text,
    attestationEntry.path,
    limits,
  );

  const artifacts: TargetArtifactRef[] = loaded.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    byteLength: file.bytes.length,
    kind:
      file.path === SALESFORCE_MANIFEST_PATH
        ? 'SALESFORCE_BUNDLE_MANIFEST'
        : (entries.find((entry) => entry.path === file.path) as ManifestEntry).kind,
  }));

  return {
    contractVersion: TARGET_CONTRACT_VERSION,
    parserVersion: TARGET_PARSER_VERSION,
    instance,
    capturedAt,
    artifacts: [...artifacts].sort((a, b) => compareCodeUnits(a.path, b.path)),
    objects: [...objects].sort((a, b) => compareCodeUnits(a.apiName, b.apiName)),
    // Salesforce has no pipeline in the sense this contract carries one: a stage
    // is a picklist value on Opportunity.StageName, which is already in the
    // field above. Emitting a pipeline here would invent a structure the org
    // does not have.
    pipelines: [],
  };
}

function exactlyOne(entries: readonly ManifestEntry[], kind: SalesforceArtifactKind): ManifestEntry {
  const only = entries[0];
  if (only !== undefined && entries.length === 1) return only;
  throw new MigrationError(
    entries.length === 0 ? 'INPUT_NOT_FOUND' : 'INPUT_DUPLICATE_FILE',
    `${SALESFORCE_MANIFEST_PATH} declares ${String(entries.length)} files of kind ${kind}; exactly one is required`,
    'A contract speaks for one org captured at one moment, so the bundle carries one org summary and one attestation.',
    { kind, count: entries.length },
  );
}

// ----------------------------------------------------------- reading from disk

/**
 * Read a bundle directory into memory.
 *
 * The refusals here are the ones only a filesystem can make. A symlink is
 * refused rather than resolved: following one reads bytes from somewhere the
 * contract would then name as a file inside the bundle, and the digest would
 * attest to a path the bytes did not come from. Every entry is also required to
 * be a plain file or a directory, so a device or a pipe cannot be opened.
 *
 * Which files exist is all this establishes. Whether that set is the declared
 * one is decided by `buildSalesforceTargetContract` against the manifest, never
 * against a directory listing.
 */
export function readSalesforceBundleDirectory(
  rootPath: string,
  limits: SalesforceBundleLimits = SALESFORCE_BUNDLE_LIMITS,
): SalesforceBundleFile[] {
  const root = resolve(rootPath);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new MigrationError(
      'INPUT_NOT_FOUND',
      `the target bundle directory "${rootPath}" was not found`,
      'Check the path to the bundle the agency handed over.',
      { path: rootPath },
    );
  }

  const found: SalesforceBundleFile[] = [];
  collectBundleFiles(realRoot, realRoot, '', 0, limits, found);
  return found.sort((a, b) => compareCodeUnits(a.path, b.path));
}

function collectBundleFiles(
  realRoot: string,
  directory: string,
  prefix: string,
  depth: number,
  limits: SalesforceBundleLimits,
  found: SalesforceBundleFile[],
): void {
  if (depth > limits.maxDirectoryDepth) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `the bundle nests deeper than ${String(limits.maxDirectoryDepth)} directories at "${prefix}"`,
      'Capture the bundle with the documented layout, which is two levels deep.',
      { limit: 'maxDirectoryDepth', allowed: limits.maxDirectoryDepth, path: prefix },
    );
  }

  const listing = readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name));
  for (const entry of listing) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const absolute = join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      throw new MigrationError(
        'TARGET_CONTRACT_INVALID',
        `the bundle entry "${relative}" is a symbolic link`,
        'Replace the link with the file itself. A contract names the bytes it was built from, and a link names somewhere else.',
        { path: relative },
      );
    }
    if (entry.isDirectory()) {
      assertBundlePath(relative, 'the bundle directory', limits);
      collectBundleFiles(realRoot, absolute, relative, depth + 1, limits, found);
      continue;
    }
    if (!entry.isFile()) {
      throw new MigrationError(
        'TARGET_CONTRACT_INVALID',
        `the bundle entry "${relative}" is neither a file nor a directory`,
        'A bundle carries plain files only.',
        { path: relative },
      );
    }

    assertBundlePath(relative, 'the bundle path', limits);
    // A junction can put a plain file inside the tree whose real bytes live
    // outside it, and asking the directory entry alone will not say so.
    if (realpathSync(absolute) !== join(realRoot, ...relative.split('/'))) {
      throw new MigrationError(
        'TARGET_CONTRACT_INVALID',
        `the bundle entry "${relative}" resolves outside the bundle root`,
        'Copy the real file into the bundle rather than linking to it.',
        { path: relative },
      );
    }

    if (found.length >= limits.maxFiles) {
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `the bundle holds more than ${String(limits.maxFiles)} files`,
        'Raise the limit if a bundle this large is expected, or split the capture.',
        { limit: 'maxFiles', allowed: limits.maxFiles },
      );
    }
    const size = statSync(absolute).size;
    if (size > limits.maxBytesPerFile) {
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `${relative} is ${String(size)} bytes, above the per-file limit of ${String(limits.maxBytesPerFile)}`,
        'Raise the limit if a file this large is expected, or re-capture the bundle.',
        { path: relative, limit: 'maxBytesPerFile', allowed: limits.maxBytesPerFile, actual: size },
      );
    }
    found.push({ path: relative, bytes: readFileSync(absolute) });
  }
}
