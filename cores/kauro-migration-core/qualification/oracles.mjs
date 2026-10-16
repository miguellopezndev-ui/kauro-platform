/**
 * What each vendor gate must have asked, declared apart from the runner that
 * asks it.
 *
 * `tools/release-candidate-gate.mjs` used to accept a vendor evidence file if
 * `result` was `PASS` and `failures` was empty. Both are the file's own words
 * about itself: a file with `cases: []`, or with half its cases missing, or
 * with one case recorded twice, satisfied every rule the gate had. The one
 * check that looked deeper read a regular expression over a case's English
 * `detail` — which is how `SF-OCR-01` shipped a case whose `ok` was true and
 * whose detail said the opposite.
 *
 * So the expectation lives here, in the same file the runner reads, and both
 * sides are held to it:
 *
 *   - the runner asserts, before it writes anything, that the case ids it
 *     produced are exactly the ids declared here — so a case that silently
 *     stopped running fails the run rather than shrinking the evidence;
 *   - the gate asserts the same thing about the committed file, and refuses
 *     duplicates, extras, absences and a `result` that disagrees with the cases.
 *
 * Two shapes, because the two halves of a vendor gate are different questions.
 * A gate whose cases are a fixed corpus (`ids`) declares them exactly. A gate
 * whose checks are generated over whatever a capture contains (`families`)
 * declares the families that must each be exercised and a floor on the count —
 * pinning the exact list there would pin one portal on one day, and the numbers
 * 209, 115 and 73 in the export route already showed what that costs.
 */

/** Every case a HubSpot import qualification must record, in the order the runner asks them. */
export const HSP_IMPORT_CASES = Object.freeze([
  'Q1-create.packageVerifies',
  'I1.contacts',
  'I1.companies',
  'I1.deals',
  'I9.contactsDelivered',
  'I10.exportBackMatchesThePackage',
  'I2.aPropertyBeyondTheIdentifiers',
  'I3.definedEnumerationValue',
  'I5.stageResolvesByInternalIdentity',
  'I5.pipelineResolvesByInternalIdentity',
  'Q2-enumeration.packageVerifies',
  'I4.undefinedEnumerationValueIsRejected',
  'I4.thePackagePredictedIt',
  // MC-3.0.0: a required value left blank is rejected by the vendor, and the package predicted it.
  'Q7-required-blank.packageVerifies',
  'I11.requiredBlankIsRejected',
  'I11.thePackagePredictedIt',
  'Q3-update.packageVerifies',
  'I6.updateCreatesNothing',
  'I6.updateKeepsTheSameRecord',
  'I6.updateChangedTheValue',
  'Q4-mixed.packageVerifies',
  'I6.mixedCreatedExactlyOne',
  'I6.mixedUpdatedTheExisting',
  'I7.theAssociationFileJoinsTheObjectFiles',
  'I7.associationResolves',
  'I8.activityObjectRefused',
  'I8.activityRelationshipRefused',
  // MC-3 additions. Each one is a thing the gate claimed and did not check.
  'X1.everyCreatedRecordIsInThisCampaignNamespace',
  'X2.cleanupRemovedExactlyTheRecordsCreated',
  'X3.theNamespaceIsEmptyOnReadBack',
]);

/** Every case a Salesforce Data Loader qualification must record. */
export const SF_DATALOADER_CASES = Object.freeze([
  'A1',
  'A1.status',
  'A2',
  'A2.created',
  'A3',
  'A3.updated',
  'A3.sameRecord',
  'A4',
  'A4.sameRecord',
  'A5',
  'A6',
  'A6.rejected',
  'A7.seed',
  'A7',
  // MC-3.0.0: a required value left blank is rejected by the vendor, and the package predicted it.
  'A8.requiredBlankIsRejected',
  'A8.thePackagePredictedIt',
  'C1',
  'C1.parentResolved',
  'L1',
  'L2',
  'L2.namesTheField',
  'O1',
  'R1.exportBack',
  'R1.sameId',
  'R1.lastWriteWon',
  // MC-3 additions: the loader runs headless through the launcher, so the run
  // has to say so, and the cleanup has to be exact.
  'H1.headlessLoginOnTheIntegrationToken',
  'H2.noBrowserFlowWasEntered',
  'H3.noTokenReachedAnyOutput',
  'X1.everyCreatedRecordIsInThisCampaignNamespace',
  'X2.cleanupRemovedExactlyTheRecordsCreated',
  'X3.theNamespaceIsEmptyOnReadBack',
]);

/** Every case the OpportunityContactRole disposition must record. */
export const SF_OCR_CASES = Object.freeze([
  'O1',
  'O2.opportunity',
  'O2.contact',
  'O2.isPrimary',
  'O2.role',
  // Present first: both of the checks below were written `field === null || …`,
  // so a describe that no longer carried ContactId satisfied 'ContactId is not
  // updateable' — the check passed most loudly where it had nothing to check.
  'O3.contactIdIsPresent',
  'O3.contactIdIsNotUpdateable',
  'O3.contactIdHasNoRelationshipName',
  'O3.adapterDoesNotClaimIt',
  'H1.headlessLoginOnTheIntegrationToken',
  'H2.noBrowserFlowWasEntered',
  'X2.cleanupRemovedExactlyTheRecordsCreated',
  'X3.theNamespaceIsEmptyOnReadBack',
]);

/**
 * The families a target-contract capture must exercise, and the floor on how
 * many checks it must have run.
 *
 * A family is a prefix of a check id. The floor is what stops a capture of
 * three properties, read faithfully as three, from passing as a qualification.
 */
export const HSP_TARGET_FAMILIES = Object.freeze({
  minimumChecks: 30,
  families: Object.freeze(['contract.', 'fields.', 'matching.', 'pipelines.', 'stages.']),
  /** At least one of these has to be present: the two capture routes ask different things. */
  routeFamilies: Object.freeze(['export.', 'api.']),
});

export const SF_TARGET_FAMILIES = Object.freeze({
  minimumChecks: 10,
  families: Object.freeze(['contract.', 'matching.']),
  routeFamilies: Object.freeze([]),
});

/** The gates, by the evidence file each one writes. */
export const VENDOR_ORACLES = Object.freeze({
  'hs-target-contract.json': { gate: 'HSP-TARGET-01', kind: 'FAMILIES', casesField: 'checks', ...HSP_TARGET_FAMILIES },
  'hs-import.json': { gate: 'HSP-TARGET-01', kind: 'IDS', casesField: 'cases', ids: HSP_IMPORT_CASES },
  'sf-target-contract.json': { gate: 'SF-TARGET-01', kind: 'FAMILIES', casesField: 'checks', ...SF_TARGET_FAMILIES },
  'sf-dataloader.json': { gate: 'SF-TARGET-01', kind: 'IDS', casesField: 'cases', ids: SF_DATALOADER_CASES },
  'sf-ocr.json': { gate: 'SF-OCR-01', kind: 'IDS', casesField: 'cases', ids: SF_OCR_CASES },
});

/**
 * Everything wrong with a set of case ids, against the oracle for a file.
 *
 * @param {string} file the evidence file's name
 * @param {readonly {id: string, ok: boolean}[]} cases
 * @returns {string[]}
 */
export function oracleProblems(file, cases) {
  const oracle = VENDOR_ORACLES[file];
  if (oracle === undefined) return [`${file} has no declared oracle, so nothing states what it had to ask`];
  const problems = [];
  if (!Array.isArray(cases) || cases.length === 0) {
    return [`${file} records no ${oracle.casesField}; a gate with nothing in it decided nothing`];
  }
  const seen = new Map();
  for (const entry of cases) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id === '') {
      problems.push(`${file} carries a ${oracle.casesField.slice(0, -1)} with no id`);
      continue;
    }
    seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) problems.push(`${file} records ${id} ${String(count)} times`);
  }

  if (oracle.kind === 'IDS') {
    const missing = oracle.ids.filter((id) => !seen.has(id));
    const extra = [...seen.keys()].filter((id) => !oracle.ids.includes(id));
    if (missing.length > 0) problems.push(`${file} is missing the declared cases ${missing.join(', ')}`);
    if (extra.length > 0) problems.push(`${file} records cases the oracle does not declare: ${extra.join(', ')}`);
    return problems;
  }

  if (cases.length < oracle.minimumChecks) {
    problems.push(`${file} ran ${String(cases.length)} checks, below the ${String(oracle.minimumChecks)} a real capture exercises`);
  }
  const ids = [...seen.keys()];
  for (const family of oracle.families) {
    if (!ids.some((id) => id.startsWith(family))) problems.push(`${file} exercises no check in the "${family}" family`);
  }
  if (oracle.routeFamilies.length > 0 && !oracle.routeFamilies.some((family) => ids.some((id) => id.startsWith(family)))) {
    problems.push(`${file} exercises none of the capture routes ${oracle.routeFamilies.join(', ')}`);
  }
  return problems;
}

/**
 * The ids a runner produced, against the ids it declared it would.
 *
 * Called by the runner itself before it writes, so a case that stopped running
 * fails the run rather than shrinking the evidence quietly.
 */
export function assertRunnerAskedEverything(file, cases) {
  const problems = oracleProblems(file, cases);
  if (problems.length > 0) {
    throw new Error(
      `this run did not ask what ${file} declares it asks:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n` +
        'Either the case is missing because something stopped it, or the oracle in qualification/oracles.mjs is out of date. ' +
        'Neither is fixed by writing the evidence.',
    );
  }
}
