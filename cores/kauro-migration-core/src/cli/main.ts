#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMigrationError, MigrationError } from '../domain/errors.js';
import { CoreInvariantError } from '../util/assert.js';
import { canonicalJsonText } from '../util/json.js';
import { CORE_VERSION } from '../version.js';
import { loadConfig } from '../mapping/load-config.js';
import { runMigration } from '../run/run-migration.js';
import { loadTargetContract } from '../target/contract.js';
import { parseAttestationAuthorities, parseTargetAttestation } from '../target/attestation.js';
import { discardStagedPackage, promotePackage, writePackage } from '../artifacts/write-package.js';
import { verifyPackage } from '../verify/verify-package.js';
import { createFilesystemScratchStore } from '../scratch/filesystem-scratch-store.js';
import { SCRATCH_BUDGET_BYTES } from '../domain/resource-profile.js';
import { sortProblems, verifyAgainstSource } from '../verify/verify-against-source.js';
import { packageDigest } from '../artifacts/package-digest.js';
import { inspectBundle, inspectionToJson, renderInspectionMarkdown, syntheticConfig } from '../profile/inspect.js';
import { buildSourceProfile, loadSourceProfile, serializeSourceProfile } from '../profile/source-profile.js';
import { buildCandidateSet, serializeCandidateSet } from '../profile/candidate-set.js';
import { sha256Hex } from '../util/hash.js';
import type { JsonValue } from '../util/json.js';

const USAGE = `kauro-core ${CORE_VERSION}

  kauro-core inspect --input <dir> --out <dir>
      Describe the source files. Changes nothing and draws no identity conclusions.

  kauro-core run --input <dir> --config <file> --out <dir> [--target-contract <file>]
                [--attestation <file>] [--attestation-issuer <file>]
                [--attestation-instant <iso8601>]
                [--source-profile <file>] [--scratch <dir>] [--force]
      Run a migration and write a verified package. Fails if the package does not verify.

      A HUBSPOT or SALESFORCE run requires a target contract and an attestation
      over it: the contract says what the destination instance holds, and the
      attestation is somebody putting their name to which instance that is. A
      capture cannot establish that about itself.

      --attestation-issuer names the issuers this deployment accepts, with their
      public keys. It is a separate file on purpose. A key that travels beside
      the signature it verifies proves only that one party wrote both.

      --attestation-instant is what freshness is judged against, so a run
      replayed later reaches the same verdict about the same evidence. It
      defaults to nothing rather than to the clock.

      CLEAN_ONLY takes none of these. It addresses no instance, so there is
      nothing for an attestation to be required of, and supplying one is refused
      rather than ignored.

  kauro-core verify --package <dir> [--target-contract <file>] [--require-target-contract]
      Re-verify a package that is already on disk, using nothing but its own bytes.
      This is package-only verification: it can catch a package that contradicts
      itself, and it cannot catch a value the package alone has no witness for.
      Without --target-contract it establishes nothing about whether the
      destination takes what 01_IMPORT holds.

      --target-contract is the captured contract you trust for the destination
      instance. Its body must re-establish its digest, the digest must be the
      one the package recorded, and the package's plan and every emitted cell
      are then held to that instance's facts: field presence, writeability, an
      implemented type, eligible option values, length, required fields.
      --require-target-contract fails a HUBSPOT or SALESFORCE package verified
      without one.

  kauro-core attest --package <dir> --source <dir> --config <file> [--core-version <v>]
                   [--target-contract <file>] [--attestation <file>]
                   [--attestation-issuer <file>] [--attestation-instant <iso8601>]
      Source-backed verification. Re-derives the truth from the original source
      bytes, the configuration the operator accepted and this core version, and
      compares the candidate against it. Nothing the package says is taken as a
      premise. The source and the configuration are hashed before and after, so
      a verification that altered what it checked against would say so.

      A HUBSPOT or SALESFORCE package needs the same contract and attestation
      the run was given. They are not a permission to verify: the contract
      decides which destination records may be matched and on which properties,
      so re-deriving without it produces a different truth and reports the
      difference as the package's fault.

  kauro-core digest --package <dir>
      Print the canonical digest of a package: one number over its bytes, so an
      attestation made elsewhere can name exactly this package. The package does
      not attest to its own truth.

Exit codes: 0 success, 1 failure.
`;

export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === '--version') {
    process.stdout.write(`${CORE_VERSION}\n`);
    return 0;
  }

  // `Object.hasOwn`, not a bare index: `COMMANDS['toString']` and
  // `COMMANDS['constructor']` are inherited and truthy, so `kauro-core toString`
  // got past the unknown-command guard and died inside the option parser with a
  // TypeError instead of the usage exit this parser exists to produce.
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (spec === undefined) {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    return USAGE_EXIT;
  }
  const parsed = parseOptions(rest, spec);
  if (parsed.problems.length > 0) {
    process.stderr.write(
      `${canonicalJsonText({ code: 'USAGE', command, problems: [...parsed.problems] })}\n` +
        `${parsed.problems.map((problem) => `  ${problem}`).join('\n')}\n\n${USAGE}`,
    );
    return USAGE_EXIT;
  }
  const options = parsed.options;

  switch (command) {
    case 'inspect':
      return commandInspect(options);
    case 'run':
      return commandRun(options);
    case 'verify':
      return commandVerify(options);
    case 'attest':
      return commandAttest(options);
    case 'digest':
      return commandDigest(options);
    default:
      // Not a fallback. A seventh command added to COMMANDS without a case here
      // used to run `digest` against it, which is a different command doing a
      // different thing under the name the operator typed.
      process.stderr.write(`${command} is declared and not implemented\n`);
      return USAGE_EXIT;
  }
}

interface Options {
  readonly flags: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

/** The exit status of a command line this program could not understand. EX_USAGE, as sysexits names it. */
export const USAGE_EXIT = 64;

/**
 * What each command accepts. A closed list, because an option this program
 * does not know is a mistake the operator has to hear about: the previous
 * parser accepted any `--name value`, so `--source-profil profile.json`
 * silently ran without the profile and `--force` followed by a stray word
 * silently became a flag with that word as its value.
 */
export interface CommandSpec {
  readonly flags: readonly string[];
  readonly required: readonly string[];
  readonly switches: readonly string[];
}

const ATTESTATION_FLAGS = ['target-contract', 'attestation', 'attestation-issuer', 'attestation-instant'] as const;

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  inspect: { flags: ['input', 'out'], required: ['input', 'out'], switches: [] },
  run: {
    flags: ['input', 'config', 'out', ...ATTESTATION_FLAGS, 'source-profile', 'scratch'],
    required: ['input', 'config', 'out'],
    switches: ['force'],
  },
  verify: { flags: ['package', 'scratch', 'target-contract'], required: ['package'], switches: ['require-target-contract'] },
  attest: {
    flags: ['package', 'source', 'config', 'core-version', ...ATTESTATION_FLAGS],
    required: ['package', 'source', 'config'],
    switches: [],
  },
  digest: { flags: ['package'], required: ['package'], switches: [] },
};

/**
 * A strict parser: every token is either a known `--flag value`, a known
 * `--flag=value`, or a known `--switch`. Anything else is a problem, and every
 * problem is reported rather than the first.
 */
export function parseOptions(argv: readonly string[], spec: CommandSpec): { options: Options; problems: readonly string[] } {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  const problems: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--') || token === '--') {
      problems.push(`unexpected argument "${token}"; options are written --name value`);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);
    if (spec.switches.includes(name)) {
      if (inlineValue !== null) problems.push(`--${name} takes no value`);
      if (switches.has(name)) problems.push(`--${name} is given more than once`);
      switches.add(name);
      continue;
    }
    if (!spec.flags.includes(name)) {
      problems.push(`unknown option --${name}`);
      // Skip a value that belongs to the unknown option, so it is not reported
      // twice as an unexpected argument.
      const next = argv[index + 1];
      if (inlineValue === null && next !== undefined && !next.startsWith('--')) index += 1;
      continue;
    }
    let value: string | null = inlineValue;
    if (value === null) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        problems.push(`--${name} needs a value`);
        continue;
      }
      value = next;
      index += 1;
    }
    if (value === '') {
      problems.push(`--${name} needs a value`);
      continue;
    }
    if (flags.has(name)) {
      problems.push(`--${name} is given more than once`);
      continue;
    }
    flags.set(name, value);
  }
  for (const name of spec.required) {
    if (!flags.has(name)) problems.push(`--${name} is required`);
  }
  return { options: { flags, switches }, problems };
}

function require(options: Options, name: string): string {
  const value = options.flags.get(name);
  if (value === undefined) {
    throw new MigrationError('CONFIG_INVALID', `--${name} is required`, USAGE, { flag: name });
  }
  return value;
}

function commandInspect(options: Options): number {
  const inputRoot = require(options, 'input');
  const outDir = resolve(require(options, 'out'));

  const report = inspectBundle({ inputRoot });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'inspection.json'), Buffer.from(canonicalJsonText(inspectionToJson(report)), 'utf8'));
  writeFileSync(join(outDir, 'inspection.md'), Buffer.from(renderInspectionMarkdown(report), 'utf8'));

  // The versioned, hashable profile beside the human report.
  //
  // The report is for a person to read; the profile is what a plan is compiled
  // against and what a run is bound to. Writing both means the operator keeps
  // the one they can act on and the machine keeps the one it can compare.
  const profileScratch = createFilesystemScratchStore({
    root: resolve(`${outDir}.kauro-work`),
    runId: 'inspect',
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });
  try {
    const config = syntheticConfig(report.files.map((file) => ({ path: file.path, format: file.format as 'CSV' | 'XLSX' })));
    const profiled = buildSourceProfile({ inputRoot, config, scratch: profileScratch });
    // The profile with the name it claims, in the form `loadSourceProfile`
    // reads: content and hash together, so a file edited after it was written
    // is refused rather than believed.
    writeFileSync(join(outDir, 'source-profile.json'), Buffer.from(serializeSourceProfile(profiled), 'utf8'));
    process.stdout.write(`source profile ${profiled.profileHash}\n`);

    // What Intelligence may choose among, from the profile alone. The
    // configuration hash is the synthetic reading's, which is what this profile
    // was built under; a run under a plan produces its own set against that
    // plan's hash.
    const candidates = buildCandidateSet({
      profile: profiled,
      configHash: sha256Hex(canonicalJsonText(JSON.parse(JSON.stringify(config)) as JsonValue)),
    });
    writeFileSync(join(outDir, 'candidate-set.json'), Buffer.from(serializeCandidateSet(candidates), 'utf8'));
    process.stdout.write(
      `candidate set ${candidates.candidateSetHash} (${String(candidates.candidateSet.candidates.length)} candidates${candidates.candidateSet.limits.truncated ? ', truncated' : ''})\n`,
    );
  } finally {
    profileScratch.dispose();
  }

  const sheets = report.files.reduce((sum, file) => sum + file.sheets.length, 0);
  const rows = report.files.reduce(
    (sum, file) => sum + file.sheets.reduce((inner, sheet) => inner + sheet.dataRows, 0),
    0,
  );
  process.stdout.write(
    `inspected ${String(report.files.length)} files, ${String(sheets)} sheets, ${String(rows)} data rows -> ${outDir}\n`,
  );
  return 0;
}

function commandRun(options: Options): number {
  const inputRoot = require(options, 'input');
  const configPath = resolve(require(options, 'config'));
  const outDir = resolve(require(options, 'out'));
  const force = options.switches.has('force');

  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);

  // Optional because a host that has no profile cannot be made to invent one.
  // Where it supplies one, the run refuses to proceed unless the profile
  // describes the bundle it actually read.
  const profilePath = options.flags.get('source-profile');
  const sourceProfile =
    profilePath === undefined
      ? null
      : loadSourceProfile(readFileSync(resolve(profilePath), 'utf8'), resolve(profilePath));

  // What the destination instance holds, and who says so.
  //
  // A HubSpot or Salesforce run requires both: the contract describes an
  // instance, and the attestation is somebody putting their name to which
  // instance it describes. A capture cannot establish that about itself — a
  // property export carries no portal id, and this repository has already
  // attributed one to the wrong portal because the credential of the day
  // pointed somewhere else.
  //
  // The key is a third flag rather than something read out of the attestation,
  // and that separation is the whole point of the check. A signature verified
  // with a key that travelled beside it proves only that whoever wrote the
  // attestation also wrote the key. The deployment says which issuers it
  // accepts; the attestation says only who it claims to be.
  const contractPath = options.flags.get('target-contract');
  const targetContract =
    contractPath === undefined
      ? null
      : loadTargetContract(readFileSync(resolve(contractPath), 'utf8'), resolve(contractPath));

  const attestationPath = options.flags.get('attestation');
  const targetAttestation =
    attestationPath === undefined
      ? null
      : parseTargetAttestation(readFileSync(resolve(attestationPath), 'utf8'), resolve(attestationPath));

  const authorityPath = options.flags.get('attestation-issuer');
  const attestationAuthorities =
    authorityPath === undefined
      ? []
      : parseAttestationAuthorities(readFileSync(resolve(authorityPath), 'utf8'), resolve(authorityPath));

  // Freshness is judged against an instant the caller states, never the clock.
  // A run replayed a year later must reach the same verdict about the same
  // evidence, and a check against `now` would make the answer depend on when
  // somebody happened to press the button.
  const attestationInstant = options.flags.get('attestation-instant') ?? null;

  // The run's own state is released before the package is verified.
  //
  // Verification reads the package back off disk and needs nothing the run
  // held, but keeping `result` in scope across the call keeps every lineage
  // entry, every recorded change and every delivered record alive underneath
  // it. On a large migration that is most of the memory the whole command uses,
  // held for the longest stage, for nothing. What the summary line needs is
  // eight numbers, so it takes the eight numbers.
  let summary: {
    runId: string;
    total: number;
    output: number;
    merged: number;
    isolated: number;
    leftover: number;
    rejected: number;
  };
  // Where the run spills what it has finished looking at.
  //
  // The CLI is the host here, so the CLI chooses: a directory beside the
  // package, named after the configuration so a rerun of the same work reuses
  // the same name and nothing depends on when it ran. It is disposed in a
  // finally, on every path, because it holds customer data.
  const scratchRoot = options.flags.get('scratch') ?? `${outDir}.kauro-work`;
  const scratch = createFilesystemScratchStore({
    root: resolve(scratchRoot),
    runId: `cli${loaded.configHash.slice(0, 16)}`,
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });

  let written: ReturnType<typeof writePackage>;
  try {
    let result: ReturnType<typeof runMigration> | null = runMigration({
      inputRoot,
      config: loaded.config,
      configHash: loaded.configHash,
      targetContract,
      targetAttestation,
      attestationAuthorities,
      attestationInstant,
      sourceProfile,
      scratch,
    });
    written = writePackage({
      result,
      config: loaded.config,
      normalizedConfig: loaded.normalizedJson,
      outputDir: outDir,
      force,
    });
    const rows = result.reconciliation.sourceRows;
    summary = {
      runId: result.truth.runId,
      total: rows.total,
      output: rows.byDisposition.OUTPUT,
      merged: rows.byDisposition.MERGED_PROVEN,
      isolated: rows.byDisposition.ISOLATED,
      leftover: rows.byDisposition.LEFTOVER,
      rejected: rows.byDisposition.REJECTED_INPUT,
    };
    result = null;

    // Verified where it was staged, and published only if it passes. This is
    // the order the contract asks for, and the reason it matters is the failure
    // case: a package that does not verify never appears at the destination at
    // all, rather than appearing and then being described as bad in a message
    // somebody may not read.
    //
    // Inside the same block as the run, because verification reads the families
    // the run spilled and the scratch is disposed when this block ends.
    // Against the contract the run was given, when it was given one: the same
    // rule that shaped the package is asked of the bytes it wrote.
    const report = verifyPackage(written.stagingDir, targetContract === null ? { scratch } : { scratch, targetContract, requireTargetContract: true });
    if (!report.passed) {
      discardStagedPackage(written);
      process.stderr.write(
        `${canonicalJsonText({
          code: 'ARTIFACT_VERIFICATION_FAILED',
          message: 'the package this run produced does not verify, and was not delivered',
          problems: report.problems.map((problem) => ({ check: problem.check, detail: problem.detail })),
        })}`,
      );
      return 1;
    }

    promotePackage(written, { force });
  } finally {
    scratch.dispose();
  }

  process.stdout.write(
    `run ${summary.runId}: ${String(summary.total)} source rows -> ` +
      `${String(summary.output)} output, ${String(summary.merged)} merged, ` +
      `${String(summary.isolated)} isolated, ${String(summary.leftover)} leftover, ` +
      `${String(summary.rejected)} rejected; ` +
      `${String(written.artifacts.length)} artifacts verified -> ${written.outputDir}\n`,
  );
  return 0;
}

function commandVerify(options: Options): number {
  const packageDir = require(options, 'package');
  // Verification spills the projections it joins on, and the CLI is the host
  // that says where. Beside the package by default, because that is a place
  // the operator already chose; `--scratch` moves it.
  const scratchRoot = options.flags.get('scratch');
  const scratch = createFilesystemScratchStore({
    root: resolve(scratchRoot ?? `${packageDir}.kauro-verify`),
    runId: 'verify',
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });
  let report;
  try {
    const contractPath = options.flags.get('target-contract');
    const targetContract =
      contractPath === undefined ? undefined : loadTargetContract(readFileSync(resolve(contractPath), 'utf8'), resolve(contractPath));
    report = verifyPackage(packageDir, {
      scratch,
      ...(targetContract === undefined ? {} : { targetContract }),
      requireTargetContract: options.switches.has('require-target-contract'),
    });
  } finally {
    scratch.dispose();
  }
  if (!report.passed) {
    process.stderr.write(
      `${canonicalJsonText({
        code: 'ARTIFACT_VERIFICATION_FAILED',
        packageDir: report.packageDir,
        problems: report.problems.map((problem) => ({ check: problem.check, detail: problem.detail })),
      })}`,
    );
    return 1;
  }
  process.stdout.write(
    `package verified: ${String(report.artifactCount)} artifacts, ${String(report.sourceRows)} source rows, ${String(report.checks.length)} checks passed\n`,
  );
  return 0;
}

function commandAttest(options: Options): number {
  // The same evidence the run was given, because this re-derives the run.
  //
  // A CRM package could not be attested at all without these. Source-backed
  // verification re-runs the migration from the source bytes, and the target
  // contract is an input to that derivation rather than a permission slip: it
  // decides which destination records may be matched and on which properties.
  // Re-deriving without it does not produce the same truth and compare — it
  // produces a different truth and blames the package for the difference.
  //
  // The measurement that found this: every HubSpot and Salesforce package in the
  // capacity matrix came back unattested with TARGET_CONTRACT_INVALID, so the
  // strongest check the engine has was switched off for two of three modes by
  // the change that was meant to strengthen it.
  const contractPath = options.flags.get('target-contract');
  const attestationPath = options.flags.get('attestation');
  const authorityPath = options.flags.get('attestation-issuer');

  const report = verifyAgainstSource({
    packageDir: require(options, 'package'),
    sourceRoot: require(options, 'source'),
    configPath: require(options, 'config'),
    ...(options.flags.has('core-version') ? { coreVersion: require(options, 'core-version') } : {}),
    targetContract:
      contractPath === undefined
        ? null
        : loadTargetContract(readFileSync(resolve(contractPath), 'utf8'), resolve(contractPath)),
    targetAttestation:
      attestationPath === undefined
        ? null
        : parseTargetAttestation(readFileSync(resolve(attestationPath), 'utf8'), resolve(attestationPath)),
    attestationAuthorities:
      authorityPath === undefined
        ? []
        : parseAttestationAuthorities(readFileSync(resolve(authorityPath), 'utf8'), resolve(authorityPath)),
    attestationInstant: options.flags.get('attestation-instant') ?? null,
  });

  if (!report.passed) {
    process.stderr.write(
      `${canonicalJsonText({
        code: 'SOURCE_VERIFICATION_FAILED',
        packageDir: report.packageDir,
        authorityUnchanged: report.authorityUnchanged,
        counts: { ...report.counts },
        problems: sortProblems(report.problems).map((problem) => ({
          check: problem.check,
          detail: problem.detail,
        })),
      })}`,
    );
    return 1;
  }

  process.stdout.write(
    `package attested against source: ${String(report.checks.length)} checks passed
` +
      `  configuration: ${report.configPath}
` +
      `  source:        ${report.sourceRoot}
` +
      `  core version:  ${report.coreVersion}
` +
      report.authority.map((entry) => `  ${entry.sha256Before}  ${entry.path}
`).join(''),
  );
  return 0;
}

function commandDigest(options: Options): number {
  const computed = packageDigest(require(options, 'package'));
  process.stdout.write(`${computed.digest}  ${String(computed.fileCount)} files
`);
  return 0;
}

function run(): void {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (isMigrationError(error)) {
      process.stderr.write(`${canonicalJsonText(error.toJson())}`);
      process.stderr.write(`\n${error.message}\n${error.remedy}\n`);
    } else if (error instanceof CoreInvariantError) {
      process.stderr.write(`${canonicalJsonText({ invariant: error.invariant, message: error.message, details: error.details })}`);
      process.stderr.write('\nThis is a defect in the engine. No package was delivered.\n');
    } else {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}

run();
