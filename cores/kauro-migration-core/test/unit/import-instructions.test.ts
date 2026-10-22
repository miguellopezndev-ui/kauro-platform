import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readTable, readTextArtifact, repoRoot, runFixture } from '../support/harness.js';

/**
 * What the instructions tell an operator about relationships (N1-1).
 *
 * The instructions are the only place an operator learns how a package is
 * imported, so a step they describe has to be one the destination actually
 * offers. Two of the three steps 3.0.0 described were not:
 *
 *   - HubSpot associates two files only through a common column that is a
 *     unique identifier of one of the objects (Record ID, Email, Company domain
 *     name, or a custom property requiring unique values; knowledge base "Set up
 *     your import file", Imports API guide). The association key is none of
 *     those, and both object files carry a column under its header with
 *     different values, so selecting it as the common column associates nothing.
 *     The qualification campaign associated contacts and companies through the
 *     company's domain (qualification/hubspot/run-import-qualification.mjs, I7).
 *   - Salesforce links a Contact or an Opportunity to its Account through the
 *     AccountId lookup, and no file of the package carries a Salesforce Id. The
 *     ids exist only once the Accounts are loaded, in Data Loader's success file,
 *     which starts with ID, repeats every column of the input row (the unmapped
 *     association key included) and ends with STATUS (forcedotcom/dataloader
 *     v67.0.0, AbstractAction.openSuccessWriter, AbstractLoadAction.getStatusColumns).
 *
 * And a relationship the destination does not support was listed as a file
 * "pairing" records, beside the ones it does.
 */

const ACCEPTANCE = join(repoRoot(), 'test', 'fixtures', 'acceptance');

function instructionsOf(caseId: string): { text: string; packageDir: string } {
  const run = runFixture(ACCEPTANCE, caseId, { scratchName: `instructions-${caseId}` });
  assert.equal(run.verification.passed, true, JSON.stringify(run.verification.problems).slice(0, 600));
  return { text: readTextArtifact(run.packageDir, 'import-instructions.md'), packageDir: run.packageDir };
}

function lineAbout(text: string, path: string): string {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`- \`${path}\``));
  assert.ok(line !== undefined, `the instructions name ${path}`);
  return line;
}

describe('[N1-1] Salesforce instructions describe the steps Data Loader offers', () => {
  const { text, packageDir } = instructionsOf('D-salesforce');

  it('names the unsupported relationship as unsupported, with its leftovers, and not as a pairing', () => {
    const line = lineAbout(text, '01_IMPORT/salesforce/associations/contact_to_deal.csv');
    assert.ok(!line.includes('Each row pairs'), line);
    assert.ok(line.includes('not supported by SALESFORCE'), line);
    assert.ok(line.includes('OpportunityContactRole'), line);
    const leftovers = readTable(packageDir, 'leftovers.csv').rows.length;
    assert.ok(line.includes(`${String(leftovers)} relationships of this type`), `${line} (leftovers.csv holds ${String(leftovers)})`);
    assert.ok(line.includes('02_EXCEPTIONS/leftovers.csv'), line);
  });

  it('still describes the supported relationships as pairings, with their own counts', () => {
    const toCompany = lineAbout(text, '01_IMPORT/salesforce/associations/contact_to_company.csv');
    assert.ok(toCompany.includes('Each row pairs'), toCompany);
    const pairs = readTable(packageDir, '01_IMPORT/salesforce/associations/contact_to_company.csv').rows.length;
    assert.ok(toCompany.includes(`${String(pairs)} relationships`), `${toCompany} (the file holds ${String(pairs)})`);
  });

  it('says the object files alone create no relationship, and how the Account Id is proved', () => {
    assert.ok(text.includes('importing the object files alone creates the records and no relationship'));
    assert.ok(text.includes('`AccountId`'));
    assert.ok(text.includes('starts with an `ID` column'));
    assert.ok(text.includes('leaving `Kauro_Association_Key__c` unmapped'));
    assert.ok(text.includes('more than once'), 'a key imported twice proves no id');
    assert.ok(!text.includes('use the pairing to populate the lookup field'), 'the 3.0.0 wording promised a step it did not describe');
  });

  it('does not promise relationships "to be created" by the import', () => {
    assert.ok(!text.includes('relationships to be created'));
    assert.ok(text.includes('The association files deliver 8 relationships'));
  });
});

describe('[N1-1] HubSpot instructions describe the steps the importer offers', () => {
  const { text } = instructionsOf('D-hubspot');

  it('never tells the operator to use the association key as a common column', () => {
    assert.ok(!text.includes('select it under "Common column headers found in your files"'));
    assert.ok(text.includes('is not a unique identifier'));
    assert.ok(text.includes('do not select it as a common column'));
  });

  it('names the identifiers HubSpot accepts as a common column and the error file to check', () => {
    for (const fragment of ['Record ID', 'Email', 'Company domain name', 'requires unique values', 'ASSOCIATION_RECORD_NOT_FOUND']) {
      assert.ok(text.includes(fragment), `missing "${fragment}"`);
    }
    assert.ok(text.includes('importing the object files alone creates the records and no association'));
  });

  it('does not promise relationships "to be created" by the import', () => {
    assert.ok(!text.includes('relationships to be created'));
    assert.ok(text.includes('The association files deliver 12 relationships'));
  });
});

describe('[N1-1] clean-only instructions are unchanged in substance', () => {
  const { text } = instructionsOf('A-clean-multi-object');

  it('still says nothing is imported and the pairs are the delivered representation', () => {
    assert.ok(text.includes('nothing is imported anywhere'));
    assert.ok(text.includes('The association files deliver 12 relationships'));
  });
});
