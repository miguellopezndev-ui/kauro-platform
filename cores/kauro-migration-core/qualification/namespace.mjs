/**
 * A campaign's namespace in a vendor tenant, and the ledger of what it created.
 *
 * ---- what this replaces ----
 *
 * The HubSpot import gate began by deleting. `clearPortal()` searched the portal
 * for every contact whose email contained the qualification domain, every
 * company whose domain contained it, and every deal whose name contained
 * "Analytical" or "Bletchley", and deleted all of them — records it had not
 * created, matched by a pattern, in a tenant it did not own the whole of. It ran
 * at module load, before anything had established which portal the credential
 * was even pointing at. A qualification that starts by removing whatever looks
 * like test data is one bad pattern away from removing something else, and
 * "whatever looks like test data" is not a thing a program can know.
 *
 * The Salesforce runners had the same shape in a milder form: they created
 * records with fixed names, and a second run collided with the first.
 *
 * ---- what this does instead ----
 *
 * Every campaign gets a namespace derived from its sealed id, and every record a
 * runner creates is created inside it: emails at a subdomain of the
 * qualification domain, company domains under the same subdomain, names carrying
 * the namespace as a prefix. Three things follow.
 *
 *   - Two campaigns cannot collide, so a run does not have to clear anything
 *     before it starts. It asserts its namespace is empty, which is a question
 *     rather than an action, and refuses if it is not: a namespace that already
 *     holds records means a previous run of *this* campaign did not finish, and
 *     deleting its records automatically would destroy the evidence of why.
 *
 *   - Cleanup deletes by id. The ledger holds every id the vendor returned, and
 *     the run deletes exactly those and then reads each one back to see that it
 *     is gone. Nothing is matched by a pattern, and a record the runner did not
 *     create cannot be reached by this code at all.
 *
 *   - What a run left behind is a number in the evidence rather than a hope. A
 *     delete that failed, or a read-back that still finds the record, is
 *     recorded as left behind with its id.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { readCampaign } from './campaign.mjs';

/** The domain the synthetic corpora are written against. */
export const QUALIFICATION_DOMAIN = 'kauro-qualification.dev';

/**
 * The namespace of the campaign this tree is sealed under.
 *
 * A DNS label: it becomes a subdomain of the qualification domain, so it starts
 * with a letter and holds only letters and digits. Derived from the campaign id
 * rather than chosen, so two runners of one campaign agree without being told.
 *
 * @param {string|null} campaignId optional, for a caller that already read it
 * @returns {{namespace: string, campaignId: string, domain: string}}
 */
export function campaignNamespace(campaignId = null) {
  const id = campaignId ?? readCampaign()?.campaignId ?? null;
  if (typeof id !== 'string' || !/^c_[0-9a-f]{16}$/u.test(id)) {
    throw new Error(
      'no campaign is sealed, so there is no namespace to write in. Seal one with "node tools/seal-campaign.mjs": ' +
        'records created outside a campaign cannot be grouped with the evidence they belong to, and cannot be cleaned up by it either.',
    );
  }
  const namespace = `q${id.slice(2, 12)}`;
  return { namespace, campaignId: id, domain: `${namespace}.${QUALIFICATION_DOMAIN}` };
}

/**
 * A corpus case, instantiated at this campaign's namespace.
 *
 * The corpus is committed with the bare qualification domain in it, and this
 * writes a copy with every occurrence replaced by the campaign's subdomain. What
 * goes to the vendor is still exactly what the engine produced — the engine is
 * run over this copy — and two campaigns produce disjoint sets of records.
 *
 * Names that carry no domain get the namespace as a bracketed prefix, so a deal
 * or an account created by one campaign is recognisable in a tenant that holds
 * another's. The substitution is textual and total: a case that grows a new file
 * is covered without anybody remembering this exists.
 *
 * @param {string} sourceDir the committed corpus case
 * @param {string} targetDir where the instantiated copy goes
 * @param {string} namespace from `campaignNamespace()`
 * @param {{prefixColumns?: readonly string[]}} options columns whose values carry no domain and must be
 *   namespaced some other way — a deal name, an opportunity name, an account name. Their values are
 *   prefixed with the namespace in brackets. Without this a check that reads records back by name
 *   matches every campaign's records at once, which is how a run that created two deals found four.
 * @returns {{files: string[], substitutions: number, prefixed: number}}
 */
export function instantiateCorpus(sourceDir, targetDir, namespace, options = {}) {
  const prefixColumns = options.prefixColumns ?? [];
  const prefix = `[${namespace}] `;
  if (!existsSync(sourceDir)) throw new Error(`there is no corpus case at ${sourceDir}`);
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  const files = [];
  let substitutions = 0;
  let prefixed = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(csv|json)$/iu.test(entry.name)) continue;
      const before = readFileSync(full, 'utf8');
      let after = before.split(QUALIFICATION_DOMAIN).join(`${namespace}.${QUALIFICATION_DOMAIN}`);
      const domainHits = before.split(QUALIFICATION_DOMAIN).length - 1;
      let prefixHits = 0;
      if (prefixColumns.length > 0 && /\.csv$/iu.test(entry.name)) {
        const written = prefixColumnValues(after, prefixColumns, prefix);
        after = written.text;
        prefixHits = written.prefixed;
      }
      if (after === before) continue;
      writeFileSync(full, after);
      substitutions += domainHits;
      prefixed += prefixHits;
      files.push(relative(targetDir, full).split(sep).join('/'));
    }
  };
  walk(targetDir);
  return { files, substitutions, prefixed };
}

/**
 * Prefix the values of named columns.
 *
 * Deliberately simple: these corpora are written with unquoted fields and no
 * commas inside them, and a case that needs a quoted field will be caught by
 * the first check that reads the value back. Rewriting them through a full CSV
 * parser and writer would round-trip the file through a second implementation
 * of the format the engine is being qualified on, which is the one thing this
 * must not do.
 */
function prefixColumnValues(text, columns, prefix) {
  const lines = text.split('\n');
  if (lines.length === 0) return { text, prefixed: 0 };
  const headers = (lines[0] ?? '').split(',');
  const targets = headers.map((header, index) => (columns.includes(header.trim()) ? index : -1)).filter((index) => index !== -1);
  if (targets.length === 0) return { text, prefixed: 0 };
  let prefixed = 0;
  for (let line = 1; line < lines.length; line += 1) {
    const raw = lines[line];
    if (raw === undefined || raw.trim() === '') continue;
    if (raw.includes('"')) {
      throw new Error(
        `a corpus row holds a quoted field and a column of it is being namespaced, which this rewrite cannot do safely: ${raw.slice(0, 60)}`,
      );
    }
    const cells = raw.split(',');
    for (const index of targets) {
      if (cells[index] === undefined || cells[index] === '') continue;
      if (cells[index].startsWith(prefix)) continue;
      cells[index] = `${prefix}${cells[index]}`;
      prefixed += 1;
    }
    lines[line] = cells.join(',');
  }
  return { text: lines.join('\n'), prefixed };
}

/**
 * The records one runner created, and their disposal.
 *
 * `record()` is called with what the vendor returned, so an id in the ledger is
 * an id the vendor confirmed. `dispose()` deletes each one and reads it back;
 * anything still present afterwards is reported rather than assumed gone.
 */
export function createdLedger({ vendor, instanceId, namespace }) {
  /** @type {Array<{objectType: string, id: string, note: string|null, createdAt: string}>} */
  const created = [];
  return {
    get entries() {
      return [...created];
    },
    get count() {
      return created.length;
    },
    /**
     * @param {string} objectType the vendor's name for the collection
     * @param {string} id the id the vendor returned
     * @param {string|null} note what it was, for a reader of the evidence
     */
    record(objectType, id, note = null) {
      if (typeof id !== 'string' || id === '') {
        throw new Error(`${vendor}: a ${objectType} was created and the response carried no id, so nothing can delete it`);
      }
      created.push({ objectType, id, note, createdAt: `${new Date().toISOString().slice(0, 19)}Z` });
    },
    /**
     * Delete every recorded id, then read each one back.
     *
     * @param {(objectType: string, id: string) => {deleted: boolean, detail: string|null}} remove
     * @param {(objectType: string, id: string) => {present: boolean, detail: string|null}} readBack
     */
    dispose(remove, readBack) {
      const outcomes = [];
      for (const entry of created) {
        let removal = { deleted: false, detail: 'the delete was not attempted' };
        try {
          removal = remove(entry.objectType, entry.id);
        } catch (error) {
          removal = { deleted: false, detail: String(error && error.message ? error.message : error) };
        }
        let after = { present: true, detail: 'the read-back was not attempted' };
        try {
          after = readBack(entry.objectType, entry.id);
        } catch (error) {
          after = { present: true, detail: String(error && error.message ? error.message : error) };
        }
        outcomes.push({
          objectType: entry.objectType,
          id: entry.id,
          note: entry.note,
          deleted: removal.deleted === true,
          stillPresent: after.present === true,
          detail: after.detail ?? removal.detail ?? null,
        });
      }
      const leftBehind = outcomes.filter((outcome) => outcome.stillPresent);
      return {
        vendor,
        instanceId,
        namespace,
        requested: outcomes.length,
        deleted: outcomes.filter((outcome) => outcome.deleted).length,
        confirmedGone: outcomes.length - leftBehind.length,
        leftBehind: leftBehind.map((outcome) => ({ objectType: outcome.objectType, id: outcome.id, detail: outcome.detail })),
        ok: leftBehind.length === 0,
        outcomes,
        note:
          'Deleted by id, one at a time, and each one read back afterwards. Nothing is matched by a pattern and nothing ' +
          'this runner did not create is reachable from here.',
      };
    },
  };
}

/**
 * How large the corpus a runner instantiated is, for the evidence.
 *
 * @param {string} dir
 */
export function corpusSize(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files += 1;
      bytes += statSync(full).size;
    }
  };
  walk(dir);
  return { files, bytes };
}
