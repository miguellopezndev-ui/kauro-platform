// Multi-file SUPPORTED fixtures (B04 multi-file mandate; D4-CORP-6): a source of several files in one fixture, whose planted truth
// needs the four tasks one file cannot raise — ASSOCIATION_MAPPING (a key column of one file naming the record of another),
// DUPLICATE_SIGNAL_STRATEGY (a signal shared by records of two files, or twice in one, that Migration Core's dry run reports),
// IDENTITY_STRATEGY (a column of two exports that the target contract itself flags as an external id) and CONSISTENCY_REVIEW (a key
// column that is also a mapped field, so an association and a field claim one column).
//
// Everything here PLANTS: files, columns, values, the target contract's external id, the project's declarations of each file, the
// host's read configuration of the signal columns. The truth is the template's own decision about what it planted; nothing of IC
// (resolver, compiler, planner, kernel, gateway, oracle) runs here. `structureProblems` restates the public contract of the four
// tasks over planted facts (D4-CORP-5, extended): it reads the frozen data plane (the profiler's shapes, the dry run's duplicate
// clusters, the adapters' relationships) and never a run of IC, and it is what the generator checks before accepting a draw.
import { RELATIONSHIP_SHAPES, RELATIONSHIP_TYPES, getAdapter } from 'kauro-migration-core';
import { companyName, exactTargetsOf, available, builder, chance, int, noGates, pick, rngOf, sample, universeOf } from './lib.mjs';
import { duplicateClustersOf, shapesOf, sourceFilesOf } from './bind.mjs';

// ------------------------------------------------------------------------------------------------- the public rules, restated
const squeeze = (text) => text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/gu, '');
const wordsOf = (text) => text.normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length >= 3);
/** The canonical object a header token names (D3-CAP-08): a key column that names another object refers to it. */
const OBJECT_OF_TOKEN = Object.freeze({ contact: 'CONTACT', contacts: 'CONTACT', contacto: 'CONTACT', person: 'CONTACT', company: 'COMPANY', companies: 'COMPANY', account: 'COMPANY', accounts: 'COMPANY', organisation: 'COMPANY', organization: 'COMPANY', empresa: 'COMPANY', cuenta: 'COMPANY', deal: 'DEAL', deals: 'DEAL', opportunity: 'DEAL', opportunities: 'DEAL', negocio: 'DEAL', lead: 'LEAD', leads: 'LEAD' });
const objectsNamedBy = (header) => new Set(wordsOf(header).flatMap((token) => (OBJECT_OF_TOKEN[token] === undefined ? [] : [OBJECT_OF_TOKEN[token]])));
/** The destinations Migration Core reads duplicate signals from (D3-CAP-07). */
const SIGNAL_DESTINATIONS = new Set(['contact.email', 'contact.phone', 'contact.firstName', 'contact.lastName', 'company.domain']);
/** What a header or a shape that reads as a contact signal is (the resolver never lends identity authority to one, D3-CAP-06). */
const SIGNAL_HEADER = /email|e-mail|mail|phone|tel|mobile|name|nombre|correo/iu;
const SIGNAL_SHAPES = new Set(['emailLike', 'phoneInternational', 'phoneLocalDigits']);

const lowerOf = (object) => object.toLowerCase();
const labelsOf = (planted) => Object.fromEntries(planted.objects.flatMap((object) => object.fields.filter((field) => field.label !== undefined).map((field) => [`${object.name}.${field.name}`, field.label])));
const distinctPopulated = (column) => column.values.every((value) => value !== '') && new Set(column.values).size === column.values.length;

/** The objects whose fields the target delivers in this mode: all four in CLEAN_ONLY, the planted contract's objects with a field the adapter maps in a vendor mode. */
function deliveredObjects(planted) {
  if (planted.mode === 'CLEAN_ONLY') return new Set(['CONTACT', 'COMPANY', 'DEAL', 'LEAD']);
  const adapter = getAdapter(planted.mode);
  const mapped = new Set(adapter.objects.flatMap((spec) => spec.fields.map((field) => field.canonicalField)));
  return new Set(planted.objects.filter((object) => object.fields.some((field) => mapped.has(`${object.name}.${field.name}`))).map((object) => object.name.toUpperCase()));
}

/**
 * Why a planted multi-file source is not one a public run can reach its truth on; empty when it is. The generator draws again on a
 * problem (UNREACHABLE_DRAW); the tests call it on the sealed corpus and on mutated plants to show that it refuses what it should.
 */
export function structureProblems(planted) {
  const problems = [];
  const files = sourceFilesOf(planted);
  if (files.length < 2 || !planted.columns.every((column) => column.file !== undefined)) return ['NOT_A_MULTI_FILE_SOURCE'];
  const declared = planted.project?.files ?? {};
  const labels = labelsOf(planted);
  const shapes = new Map();
  for (const file of files) { const read = shapesOf(file.columns, planted.mode); file.columns.forEach((column, index) => shapes.set(column, read[index] ?? [])); }
  const fileOf = new Map(files.map((file) => [file.path, file]));

  // Every file declares its object, and its record id column is its first column, unique and populated on every row.
  for (const file of files) {
    const entry = declared[file.path];
    if (entry === undefined || entry.object === null) { problems.push(`FILE_OBJECT_NOT_DECLARED:${file.path}`); continue; }
    if (entry.recordIdColumn !== undefined) {
      if (entry.recordIdColumn !== file.columns[0].header) problems.push(`RECORD_ID_NOT_FIRST_COLUMN:${file.path}`);
      else if (!distinctPopulated(file.columns[0])) problems.push(`RECORD_ID_NOT_UNIQUE_AND_POPULATED:${file.path}`);
    }
    for (const column of file.columns) if (column.values.some((value) => value === '') && column === file.columns[0]) problems.push(`FIRST_COLUMN_HAS_BLANKS:${file.path}`);
  }
  if (problems.length > 0) return problems;

  // The deterministic layer maps exactly what the truth maps and nothing else: a MAP column's header names its destination exactly and alone; no other column's does.
  for (const file of files) {
    const object = lowerOf(declared[file.path].object);
    for (const column of file.columns) {
      const claimed = exactTargetsOf(planted.mode, column.header, object, planted.objects, labels, shapes.get(column));
      if (column.decision === 'MAP') { if (claimed.length !== 1 || claimed[0] !== column.destination) problems.push(`MAP_COLUMN_NOT_CLAIMED_EXACTLY:${file.path}:${column.header}`); }
      else if (claimed.length > 0) problems.push(`UNMAPPED_COLUMN_CLAIMED_EXACTLY:${file.path}:${column.header}`);
    }
  }

  // ---------------------------------------------------------------- the association question (D3-CAP-08)
  const delivered = deliveredObjects(planted);
  const associationProblems = (column, targets) => {
    const out = [];
    const owner = fileOf.get(column.file);
    const ownerObject = declared[owner.path].object;
    const named = objectsNamedBy(column.header);
    const candidates = targets.filter((file) => file !== owner && declared[file.path].object !== ownerObject && named.has(declared[file.path].object));
    if (candidates.length === 0) return [`KEY_DOES_NOT_NAME_A_DECLARED_TARGET:${column.header}`];
    for (const target of candidates) {
      const targetObject = declared[target.path].object;
      if (declared[target.path].recordIdColumn === undefined) { out.push(`ASSOCIATION_ENDPOINT_UNDECLARED:${target.path}`); continue; }
      const relationship = RELATIONSHIP_TYPES.find((type) => (RELATIONSHIP_SHAPES[type].from === ownerObject && RELATIONSHIP_SHAPES[type].to === targetObject) || (RELATIONSHIP_SHAPES[type].from === targetObject && RELATIONSHIP_SHAPES[type].to === ownerObject));
      if (relationship === undefined || getAdapter(planted.mode).relationships[relationship].kind !== 'SUPPORTED') { out.push(`RELATIONSHIP_NOT_SUPPORTED:${ownerObject}>${targetObject}`); continue; }
      if (!delivered.has(ownerObject) || !delivered.has(targetObject)) { out.push(`OBJECT_NOT_DELIVERED:${ownerObject}>${targetObject}`); continue; }
      const ids = new Set(target.columns[0].values);
      const populated = column.values.filter((value) => value !== '');
      if (populated.length === 0) out.push(`KEY_HAS_NO_VALUES:${column.header}`);
      else if (!populated.every((value) => ids.has(value))) out.push(`KEY_VALUES_ARE_NOT_THE_TARGET_RECORD_IDS:${column.header}`);
      else return [];
    }
    return out;
  };
  for (const column of planted.columns.filter((entry) => entry.associatesWith !== undefined)) {
    const target = fileOf.get(column.associatesWith);
    if (target === undefined) problems.push(`ASSOCIATION_TARGET_FILE_UNKNOWN:${column.associatesWith}`);
    else problems.push(...associationProblems(column, [target]));
    if (column.decision !== 'PRESERVE') problems.push(`ASSOCIATION_KEY_MUST_BE_PRESERVED:${column.header}`);
  }

  // ---------------------------------------------------------------- the consistency review (D3-CAP-11): a key that is also a mapped field
  if ((planted.taskTypes ?? []).includes('CONSISTENCY_REVIEW')) {
    const reused = planted.columns.filter((column) => column.decision === 'MAP' && associationProblems(column, files).length === 0);
    if (reused.length === 0) problems.push('NO_MAPPED_COLUMN_IS_ALSO_AN_ASSOCIATION_KEY');
  }

  // ---------------------------------------------------------------- the identity question (D3-CAP-06)
  const adopting = planted.columns.filter((column) => column.adoptsIdentity === true);
  for (const column of adopting) {
    const owner = fileOf.get(column.file);
    const object = lowerOf(declared[owner.path].object);
    if (planted.mode === 'CLEAN_ONLY') { problems.push('CLEAN_ONLY_LENDS_NO_IDENTITY_AUTHORITY'); continue; }
    const key = squeeze(column.header);
    const authority = planted.objects.find((entry) => entry.name === object)?.fields.filter((field) => {
      const apiName = planted.mode === 'HUBSPOT' ? field.name.toLowerCase() : field.name;
      return field.externalId === true && (squeeze(field.label ?? field.name) === key || squeeze(apiName) === key);
    }) ?? [];
    if (authority.length === 0) problems.push(`HEADER_DOES_NOT_NAME_AN_EXTERNAL_ID_OF_THE_CONTRACT:${column.header}`);
    if (!distinctPopulated(column)) problems.push(`EXTERNAL_ID_NOT_UNIQUE_AND_POPULATED:${column.header}`);
    if (SIGNAL_HEADER.test(column.header) || (shapes.get(column) ?? []).some((shape) => SIGNAL_SHAPES.has(shape))) problems.push(`EXTERNAL_ID_READS_AS_A_SIGNAL:${column.header}`);
    if (declared[owner.path].recordIdColumn === column.header) problems.push(`EXTERNAL_ID_IS_THE_DECLARED_RECORD_ID:${column.header}`);
  }
  if (adopting.length > 0) {
    // One identity space per object needs at most one of its keyed record mappings to declare a record id (else the agency joins them).
    for (const object of new Set(adopting.map((column) => declared[column.file].object))) {
      const keyed = new Set(adopting.filter((column) => declared[column.file].object === object).map((column) => column.file));
      if ([...keyed].filter((path) => declared[path].recordIdColumn !== undefined).length > 1) problems.push(`IDENTITY_SPACE_NOT_SHARED:${object}`);
    }
  }

  // ---------------------------------------------------------------- the duplicate question (D3-CAP-07)
  const reviewed = planted.columns.filter((column) => column.inDuplicateReview === true);
  if (reviewed.length > 0) {
    const clusters = duplicateClustersOf(planted);
    if (clusters.length === 0) problems.push('NO_DUPLICATE_CLUSTER_IN_THE_DRY_RUN');
    for (const column of reviewed) {
      if (column.read === undefined || !SIGNAL_DESTINATIONS.has(column.read.destination) || column.read.destination !== column.destination) problems.push(`REVIEWED_COLUMN_IS_NOT_A_READ_SIGNAL:${column.header}`);
      if (!clusters.some((cluster) => cluster.files.includes(column.file))) problems.push(`NO_CLUSTER_IN_THE_FILE:${column.file}`);
    }
  }
  return problems;
}

// ------------------------------------------------------------------------------------------------------------- planting
const CONTACT_FILES = ['contacts.csv', 'crm-contacts.csv', 'people.csv', 'customers.csv', 'contact-export.csv'];
const SECOND_CONTACT_FILES = ['webform-signups.csv', 'event-attendees.csv', 'newsletter.csv', 'contacts-2024.csv', 'imported-leads.csv'];
const COMPANY_FILES = ['companies.csv', 'accounts.csv', 'organisations.csv', 'company-list.csv'];
const DEAL_FILES = ['deals.csv', 'opportunities.csv', 'pipeline.csv'];
const COMPANY_KEYS = ['Company ID', 'Account ID', 'Organisation ref', 'Empresa (id)', 'Cuenta ref', 'Account number'];
const DEAL_KEYS = ['Deal ID', 'Opportunity ref', 'Negocio (id)', 'Deal reference'];
// Labels that name no object (an `Account ...` label would make the column an association key) and read as no contact signal.
const EXTERNAL_ID_LABELS = ['Customer Number', 'Client Code', 'Member Number', 'Partner Code'];
const CONTACT_FIELDS = ['contact.firstName', 'contact.lastName', 'contact.jobTitle', 'contact.city'];
const COMPANY_FIELDS = ['company.domain', 'company.industry', 'company.city', 'company.website'];

/** One planted file: its builder (the columns), the object its record is, and the record id column it declares (the first column). */
function newFile(r, mode, capability, path, object, idHeader, ids, { declare = true, keyed = false } = {}) {
  const rows = ids.length;
  const b = builder(r, { mode, family: 'SUPPORTED', capability, rows, lang: 'en' });
  // A file whose record id is a mapped field (`keyed`) starts empty: its first column is that field, planted by the template.
  if (!keyed) b.raw(idHeader, 'IDENTIFIER', ids, 'PRESERVE');
  return { path, object, rows, b, declare, idHeader };
}
const idsOf = (prefix, count, start) => Array.from({ length: count }, (_, index) => `${prefix}-${String(start + index)}`);
/** Extra mapped fields of an object, beyond its anchor, the file also carries (each on its exact header), and decoy columns the truth keeps. */
function fill(r, file, mode, anchors, pool, extraMapped, noise) {
  for (const canonical of anchors) file.b.map(canonical, { exact: true, n: file.rows });
  for (const canonical of sample(r, pool.filter((c) => available(mode, c) && !anchors.includes(c)), extraMapped)) file.b.map(canonical, { exact: true, n: file.rows });
  if (noise > 0) file.b.noise(noise);
}

/** The planted facts of a source of several files: the columns of every file (each tagged by its file), the project's declarations, the target universe. */
function assemble(r, { mode, capability, files, taskTypes, forbidden = [], custom = [], extra = 0 }) {
  const columns = files.flatMap((file) => file.b.columns.map((column) => ({ ...column, file: file.path, fieldRef: `src:${file.path}:${column.header}` })));
  const mapped = columns.filter((column) => column.decision === 'MAP');
  const used = [...new Set([...mapped.map((column) => column.destination), ...forbidden])];
  const objects = universeOf(r, mode, used, { extra, moreObjects: files.map((file) => lowerOf(file.object)), custom, supplied: new Set(mapped.map((column) => column.destination)) });
  return {
    family: 'SUPPORTED', mode, capability, outcomeClass: 'PROPOSED',
    project: { object: files[0].object, ...(files[0].declare ? { recordIdColumn: files[0].idHeader } : {}), files: Object.fromEntries(files.map((file) => [file.path, { object: file.object, ...(file.declare ? { recordIdColumn: file.idHeader } : {}) }])) },
    objects, columns, forbiddenDestinations: forbidden, gates: noGates, taskTypes,
  };
}

/** The rows of a small file. */
const rowsOf = (r) => int(r, 3, 5);

/** CAP08: a key column of the contacts file whose values are the record ids of the companies (or deals) file, which declares them. */
function associationPlanted(r, mode, capability, v) {
  const toDeal = mode !== 'SALESFORCE' && v % 2 === 1;
  const owner = newFile(r, mode, capability, pick(r, CONTACT_FILES), 'CONTACT', 'Contact ID', idsOf('P', rowsOf(r), int(r, 100, 900)));
  const targetObject = toDeal ? 'DEAL' : 'COMPANY';
  const targetRows = int(r, 2, 4);
  const target = newFile(r, mode, capability, pick(r, toDeal ? DEAL_FILES : COMPANY_FILES), targetObject, toDeal ? 'Deal ID' : 'Company ID', idsOf(toDeal ? 'D' : 'C', targetRows, int(r, 100, 900)));
  fill(r, owner, mode, ['contact.email'], CONTACT_FIELDS, int(r, 0, 2), int(r, 0, 2));
  fill(r, target, mode, [toDeal ? 'deal.name' : 'company.name'], toDeal ? [] : COMPANY_FIELDS, toDeal ? 0 : int(r, 0, 2), int(r, 0, 1));
  const ids = target.b.columns[0].values;
  const keyHeader = pick(r, toDeal ? DEAL_KEYS : COMPANY_KEYS);
  owner.b.raw(keyHeader, 'IDENTIFIER', owner.b.columns[0].values.map(() => pick(r, ids)), 'PRESERVE', { associatesWith: target.path });
  const forbidden = !toDeal && available(mode, 'contact.companyName') ? ['contact.companyName'] : [];
  return assemble(r, { mode, capability, files: [owner, target], taskTypes: ['ASSOCIATION_MAPPING'], forbidden, extra: int(r, 0, 3) });
}

/** CAP07: a signal shared by records of two files (or twice in one) that the dry run reports as a duplicate cluster, never a merge. */
function duplicatePlanted(r, mode, capability, v) {
  const within = v % 3 === 2;
  const a = newFile(r, mode, capability, pick(r, CONTACT_FILES), 'CONTACT', 'Contact ID', idsOf('P', rowsOf(r) + 1, int(r, 100, 900)));
  const b = newFile(r, mode, capability, pick(r, SECOND_CONTACT_FILES), 'CONTACT', 'Submission ID', idsOf('S', rowsOf(r), int(r, 100, 900)));
  const read = { destination: 'contact.email', semanticType: 'EMAIL' };
  for (const file of [a, b]) file.b.map('contact.email', { exact: true, n: file.rows });
  const emailOf = (file) => file.b.columns.find((column) => column.destination === 'contact.email');
  const [ea, eb] = [emailOf(a), emailOf(b)];
  if (within) ea.values[ea.values.length - 1] = ea.values[0]; // the same person twice in one export, two record ids
  else { const shared = int(r, 1, Math.min(2, eb.values.length)); for (let i = 0; i < shared; i += 1) eb.values[i] = ea.values[ea.values.length - 1 - i]; }
  for (const file of [a, b]) fill(r, file, mode, [], CONTACT_FIELDS, int(r, 1, 2), int(r, 0, 2));
  // The host's read configuration reads the signal columns; the truth puts each one whose file holds a cluster in review.
  ea.read = read; eb.read = read;
  ea.inDuplicateReview = true;
  if (!within) eb.inDuplicateReview = true;
  const files = [a, b];
  if (chance(r, 0.4)) { const c = newFile(r, mode, capability, pick(r, COMPANY_FILES), 'COMPANY', 'Company ID', idsOf('C', int(r, 2, 3), int(r, 100, 900))); fill(r, c, mode, ['company.name'], COMPANY_FIELDS, int(r, 0, 1), 0); files.push(c); }
  return assemble(r, { mode, capability, files, taskTypes: ['DUPLICATE_SIGNAL_STRATEGY'], extra: int(r, 0, 3) });
}

/** CAP06: a column two exports share that the target contract itself flags as an external id: adopted as identity, with the rows it proves combined. */
function identityPlanted(r, mode, capability, v) {
  const label = pick(r, EXTERNAL_ID_LABELS);
  const field = { object: 'contact', name: mode === 'HUBSPOT' ? label.toLowerCase().replace(/\s+/gu, '_') : `${label.replace(/\s+/gu, '_')}__c`, valueClass: 'TEXT', label, externalId: true };
  const a = newFile(r, mode, capability, pick(r, CONTACT_FILES), 'CONTACT', 'Contact ID', idsOf('P', rowsOf(r), int(r, 100, 900)));
  // Migration Core 3.0.0 checks every record mapping against the destination's required fields: each contact file supplies its own.
  const requiredOf = mode === 'SALESFORCE' ? ['contact.lastName'] : ['contact.email'];
  fill(r, a, mode, [...new Set(['contact.email', ...requiredOf])], CONTACT_FIELDS, int(r, 0, 2), int(r, 0, 1));
  const numberOf = (count, start) => Array.from({ length: count }, (_, index) => `${label.split(' ')[0].slice(0, 2).toUpperCase()}-${String(start + index)}`);
  const aNumbers = numberOf(a.rows, int(r, 9000, 9500));
  a.b.raw(label, 'IDENTIFIER', aNumbers, 'PRESERVE', { adoptsIdentity: true });
  // The second export keys its rows by the number itself and declares no record id of its own: both files are one identity space.
  const bRows = rowsOf(r);
  const bNumbers = [aNumbers[aNumbers.length - 1], ...numberOf(bRows - 1, int(r, 9600, 9900))];
  const b = newFile(r, mode, capability, pick(r, SECOND_CONTACT_FILES), 'CONTACT', label, bNumbers, { declare: false });
  b.b.columns[0].decision = 'PRESERVE'; b.b.columns[0].adoptsIdentity = true;
  fill(r, b, mode, ['contact.firstName', ...requiredOf], CONTACT_FIELDS.filter((c) => c !== 'contact.firstName' && !requiredOf.includes(c)), int(r, 0, 1), int(r, 0, 1));
  const files = [a, b];
  if (v % 2 === 0) { const c = newFile(r, mode, capability, pick(r, COMPANY_FILES), 'COMPANY', 'Company ID', idsOf('C', int(r, 2, 3), int(r, 100, 900))); fill(r, c, mode, ['company.name'], COMPANY_FIELDS, int(r, 0, 1), 0); files.push(c); }
  return assemble(r, { mode, capability, files, taskTypes: ['IDENTITY_STRATEGY'], custom: [field], extra: int(r, 0, 3) });
}

/** CAP11: the company column of the contacts holds the names the companies file keys its records by: a mapped field and an association key at once. */
function consistencyPlanted(r, mode, capability) {
  const names = [...new Set(Array.from({ length: int(r, 2, 4) }, () => companyName(r)))];
  const owner = newFile(r, mode, capability, pick(r, CONTACT_FILES), 'CONTACT', 'Contact ID', idsOf('P', rowsOf(r), int(r, 100, 900)));
  fill(r, owner, mode, ['contact.email'], CONTACT_FIELDS, int(r, 0, 2), int(r, 0, 1));
  const column = owner.b.map('contact.companyName', { header: 'Company name', n: owner.rows });
  column.values = owner.b.columns[0].values.map(() => pick(r, names));
  // The companies file keys its records by company name, which is also a mapped field there.
  const target = newFile(r, mode, capability, pick(r, COMPANY_FILES), 'COMPANY', null, names, { keyed: true });
  target.b.map('company.name', { exact: true, n: names.length }).values = names;
  target.idHeader = target.b.columns[0].header;
  fill(r, target, mode, [], COMPANY_FIELDS, int(r, 0, 2), int(r, 0, 1));
  return assemble(r, { mode, capability, files: [owner, target], taskTypes: ['CONSISTENCY_REVIEW'], extra: int(r, 0, 3) });
}

/** Whether a SUPPORTED cell is planted as a multi-file source: the capabilities whose task one file cannot raise, in the rounds that alternate with the single-file ones. */
export function multiFileCell(capability, mode, round) {
  if (round % 2 !== 1) return false;
  if (capability === 'CAP06') return mode !== 'CLEAN_ONLY';
  if (capability === 'CAP07' || capability === 'CAP08') return true;
  if (capability === 'CAP11') return mode !== 'SALESFORCE';
  return false;
}

/** The multi-file SUPPORTED fixture of a cell and a draw; a draw the public rules cannot reach is drawn again (UNREACHABLE_DRAW). */
export function multiFilePlanted(capability, mode, v) {
  const r = rngOf(`MULTI|${capability}|${mode}|${String(v)}`);
  const planted = capability === 'CAP08' ? associationPlanted(r, mode, capability, v) : capability === 'CAP07' ? duplicatePlanted(r, mode, capability, v) : capability === 'CAP06' ? identityPlanted(r, mode, capability, v) : consistencyPlanted(r, mode, capability);
  const problems = structureProblems(planted);
  if (problems.length > 0) throw Object.assign(new Error(`${capability}/${mode}: ${problems.join('; ')}`), { retry: true });
  return planted;
}

