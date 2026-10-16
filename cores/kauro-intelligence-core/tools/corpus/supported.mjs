// SUPPORTED family templates (B04-FIXTURES-SUPPORTED): the twelve capabilities x three modes, each planting the
// source, the target universe, the decisions and, where several destinations are equally right, the alternatives.
// A supported fixture plants no hazard: no sentinel, no unproven identity, nothing safety critical.
//
// B04 stage 2: every truth is one a run through the public core can reach. One file holds one object (the record mapping the data
// plane runs it as), declared by the project unless the object is the question (CAP01); a MAP truth stands on a fact the request
// shows (the header names the target, the shapes read as its type, or the agency's verified convention, planted by the builder);
// a primitive is part of the truth only where its question is reachable (a parameter the declared locale or the shapes evidence, or
// the model's own mapping of a column no exact header decides). The capability tag says what the fixture is about; a task type is
// claimed only where the planted structure raises that question by the public rules (D3-CAP-01, D3-CAP-04, D3-CAP-05).
import { multiFileCell, multiFilePlanted } from './multifile.mjs';
import { DATE_FORMATS, LATIN_LANGS, SAFE_ENUM_MAP, available, availableOf, builder, chance, int, kindOf, objectsOf, pick, rngOf, sample } from './lib.mjs';

const CORE = {
  contact: ['contact.email', 'contact.firstName', 'contact.lastName', 'contact.phone', 'contact.jobTitle', 'contact.city', 'contact.country', 'contact.postalCode', 'contact.addressLine1', 'contact.website'],
  company: ['company.name', 'company.domain', 'company.industry', 'company.employeeCount', 'company.city', 'company.country', 'company.website', 'company.phone'],
  deal: ['deal.name', 'deal.amount', 'deal.closeDate', 'deal.stage', 'deal.currency'],
  lead: ['lead.lastName', 'lead.firstName', 'lead.company', 'lead.email', 'lead.phone', 'lead.status', 'lead.leadSource', 'lead.industry'],
};
const DISCRIMINATOR = { contact: 'contact.email', company: 'company.name', deal: 'deal.name', lead: 'lead.lastName' };
const shortOf = (canonical) => canonical.split('.')[1];
/** Two destinations of one object equally right for a column: a phone that may be the mobile one, a web address that may be the domain. */
const TWINS = { 'contact.phone': 'contact.mobilePhone', 'lead.phone': 'lead.mobilePhone', 'company.website': 'company.domain', 'company.domain': 'company.website' };
const ENUM_LABEL = { 'contact.lifecycleStage': 'Lifecycle stage', 'deal.stage': 'Stage', 'lead.status': 'Lead Status' };
/** A header no target names exactly, so the column goes to the model: the planted header with an export suffix. */
const SUFFIXES = [' (CRM)', ' (export)', ' - src', ' (legacy)', ' [v2]'];

/** Same-named fields of the other objects of the universe: wrong homes for a column whose object is clear. */
function homonymsOf(mode, used, objects) {
  const out = [];
  for (const canonical of used) for (const object of objects) { const twin = `${object}.${shortOf(canonical)}`; if (twin !== canonical && !used.includes(twin) && available(mode, twin)) out.push(twin); }
  return [...new Set(out)];
}
const pickLang = (r) => (chance(r, 0.45) ? 'en' : pick(r, LATIN_LANGS));
const kinds = (mode, list) => availableOf(mode, list);

export function supportedPlanted(capability, mode, v) {
  // The cells whose task one file cannot raise are planted as a source of several files in the rounds that alternate (D4-CORP-6).
  if (multiFileCell(capability, mode, v % 1000)) return multiFilePlanted(capability, mode, v);
  const r = rngOf(`SUP|${capability}|${mode}|${String(v)}`);
  const lang = pickLang(r);
  const rows = int(r, 3, 6);
  const b = builder(r, { mode, family: 'SUPPORTED', capability, rows, lang });
  const objects = objectsOf(mode);
  const noise = () => { if (chance(r, 0.55)) b.noise(int(r, 1, 2)); };
  const finish = (extra = {}) => b.planted({ extra: int(r, 0, 4), ...extra });
  const dirtyText = () => (chance(r, 0.2) ? 'pad' : 'clean');
  /** The explicit alternative of a destination, where its object offers one in this mode and the fixture does not map it as well. */
  const twinOf = (canonical, taken) => (TWINS[canonical] !== undefined && available(mode, TWINS[canonical]) && !taken.includes(TWINS[canonical]) ? { alternatives: [TWINS[canonical]] } : {});
  const fieldsOf = (object, k) => {
    const anchor = available(mode, DISCRIMINATOR[object]) ? DISCRIMINATOR[object] : kinds(mode, CORE[object])[0];
    return [anchor, ...sample(r, kinds(mode, CORE[object]).filter((c) => c !== anchor), Math.max(0, k - 1))];
  };

  switch (capability) {
    case 'CAP01': { // the object a source belongs to: the project does not declare it; the agency's memory knows these headers
      const object = pick(r, objects);
      const mapped = fieldsOf(object, int(r, 2, 4));
      const others = sample(r, objects.filter((o) => o !== object), int(r, 1, Math.min(2, objects.length - 1)));
      for (const c of mapped) b.map(c, { header: undefined, dirty: kindOf(c) === 'TEXT' ? dirtyText() : 'clean' });
      // No header names a field exactly, so no object wins on headers and the object is the run's question.
      for (const column of b.columns) column.header = `${column.header}${pick(r, SUFFIXES)}`, column.fieldRef = `src:${column.header}`;
      noise();
      const twins = homonymsOf(mode, mapped, others);
      return finish({ object: null, conventions: 'all', moreObjects: [object, ...others], universe: twins, forbidden: twins.slice(0, int(r, 1, 3)), taskTypes: ['OBJECT_MAPPING'] });
    }
    case 'CAP02': { // field mapping, with explicit alternatives where two destinations of the file's object are right
      const object = pick(r, objects.filter((o) => o !== 'deal'));
      const mapped = fieldsOf(object, int(r, 3, 6));
      for (const c of mapped) b.map(c, { dirty: kindOf(c) === 'TEXT' ? dirtyText() : 'clean', ...twinOf(c, mapped) });
      const recipes = [];
      if (object === 'contact' && !mapped.includes('contact.phone') && available(mode, 'contact.mobilePhone')) recipes.push(() => b.map('contact.phone', { header: lang === 'en' ? 'Telephone' : undefined, alternatives: ['contact.mobilePhone'] }));
      if (object === 'contact' && available(mode, 'contact.companyName') && !mapped.includes('contact.companyName')) recipes.push(() => b.map('contact.companyName', {}));
      if (object === 'lead' && !mapped.includes('lead.phone') && available(mode, 'lead.mobilePhone')) recipes.push(() => b.map('lead.phone', { alternatives: ['lead.mobilePhone'] }));
      if (object === 'company' && !mapped.includes('company.website') && available(mode, 'company.domain') && available(mode, 'company.website')) recipes.push(() => b.map('company.website', { alternatives: ['company.domain'] }));
      if (recipes.length > 0) pick(r, recipes)();
      noise();
      return finish({ object });
    }
    case 'CAP03': { // the semantic type of a column in messy shapes
      const choices = [
        ...kinds(mode, ['contact.createdAt', 'lead.createdAt', 'deal.closeDate']).map((c) => [c, `mostly:dateFmt:${pick(r, ['DD/MM/YYYY', 'MM/DD/YYYY'])}`]),
        ...kinds(mode, ['contact.phone', 'contact.mobilePhone', 'lead.phone', 'company.phone']).map((c) => [c, 'mostly:phones']),
        ...kinds(mode, ['deal.amount', 'company.employeeCount', 'company.annualRevenue']).map((c) => [c, `mostly:numbers:${pick(r, [',', '.'])}`]),
        ...kinds(mode, ['contact.doNotEmail', 'contact.doNotCall', 'lead.doNotEmail']).map((c) => [c, `mostly:bool:${pick(r, ['yn', 'sn'])}`]),
        ...kinds(mode, ['contact.email', 'lead.email']).map((c) => [c, 'case']),
        ...kinds(mode, ['contact.lifecycleStage', 'deal.stage', 'lead.status']).map((c) => [c, 'clean']),
      ];
      const object = pick(r, [...new Set(choices.map(([c]) => c.split('.')[0]))]);
      const typed = sample(r, choices.filter(([c]) => c.startsWith(`${object}.`)), int(r, 1, 3));
      b.map(available(mode, DISCRIMINATOR[object]) ? DISCRIMINATOR[object] : typed[0][0], {});
      for (const [c, dirty] of typed) if (!b.columns.some((col) => col.destination === c)) b.map(c, { dirty, semantic: true, valueClass: dirty === 'clean' || dirty === 'case' ? undefined : 'MIXED', n: dirty.includes('bool') ? Math.max(rows, 3) : rows });
      noise();
      return finish({ object });
    }
    case 'CAP04': { // the primitive the planted values call for, where the run can be asked for it
      const object = pick(r, objects.filter((o) => kinds(mode, CORE[o]).length > 0));
      const menu = [];
      const date = kinds(mode, [`${object}.createdAt`, `${object}.closeDate`])[0];
      const phone = kinds(mode, [`${object}.phone`])[0];
      const number = kinds(mode, [`${object}.amount`, `${object}.employeeCount`, `${object}.annualRevenue`])[0];
      const email = kinds(mode, [`${object}.email`])[0];
      const text = kinds(mode, [`${object}.firstName`, `${object}.lastName`, `${object}.name`, `${object}.city`, `${object}.company`])[0];
      // A date format and a phone region stand only on the project's declared locale (D3-CAP-04); a decimal separator on the shapes.
      const format = pick(r, ['DD/MM/YYYY', 'MM/DD/YYYY']);
      if (date !== undefined) menu.push(() => { b.map(date, { dirty: `dateFmt:${format}`, expect: true }); return { dateFormat: format }; });
      if (phone !== undefined) menu.push(() => { b.map(phone, { dirty: 'phonesLocal', expect: true }); return { defaultRegion: 'US' }; });
      if (number !== undefined) menu.push(() => { b.map(number, { dirty: 'decimal:,', expect: true }); return {}; });
      // A primitive without a parameter is the model's to choose with its mapping: the header does not decide the column.
      if (email !== undefined) menu.push(() => { b.map(email, { dirty: 'case', expect: true, header: `${pick(r, ['Mail', 'E-mail addr', 'Correo'])}${pick(r, SUFFIXES)}` }); return {}; });
      if (text !== undefined) menu.push(() => { b.map(text, { dirty: 'pad', expect: true, header: `${pick(r, ['Value', 'Name text', 'Label'])}${pick(r, SUFFIXES)}` }); return {}; });
      const locale = {};
      for (const make of sample(r, menu, Math.min(menu.length, int(r, 2, 3)))) Object.assign(locale, make());
      if (!b.columns.some((column) => column.decision === 'MAP')) b.map(DISCRIMINATOR[object], {});
      noise();
      return finish({ object, ...(Object.keys(locale).length === 0 ? {} : { locale }) });
    }
    case 'CAP05': { // a value map over the distinct values of a categorical column the target offers options for
      // The fields a vendor contract offers options for (lifecycle stage, deal stage, lead status); CLEAN_ONLY has the categorical fields without options.
      const enums = mode === 'CLEAN_ONLY' ? kinds(mode, ['contact.lifecycleStage', 'deal.stage', 'lead.status', 'lead.leadSource', 'lead.rating']) : kinds(mode, ['contact.lifecycleStage', 'deal.stage', 'lead.status']);
      const target = pick(r, enums);
      const object = target.split('.')[0];
      if (available(mode, DISCRIMINATOR[object])) b.map(DISCRIMINATOR[object], {});
      const vendor = mode !== 'CLEAN_ONLY';
      // In a vendor mode the column is mapped on its exact label and its values are put to the model one by one (D3-CAP-05); the
      // canonical catalog of CLEAN_ONLY has no options, so there the column is simply mapped.
      // The contract shows the field's human label (as the vendors do: Stage, Lead Status, Lifecycle stage), and the column carries it.
      const labels = vendor ? { [target]: ENUM_LABEL[target] } : {};
      const column = b.map(target, { n: int(r, 6, 12), evidence: ['ev:self'], ...(vendor ? { header: ENUM_LABEL[target], dirty: 'safeEnum' } : {}) });
      // The truth names the option each source value goes to (D4-SCORE-9): the planted reading of the word, not a run's choice.
      if (vendor) column.valueMap = [...new Set(column.values)].map((from) => ({ from, to: SAFE_ENUM_MAP[target][from] }));
      noise();
      return finish({ object, labels, ...(vendor ? { taskTypes: ['VALUE_MAP'] } : {}) });
    }
    case 'CAP06': { // a unique, fully populated key column beside the record's fields: mapped, never merged on
      const object = pick(r, objects.filter((o) => o !== 'deal'));
      const key = object === 'company' ? (available(mode, 'company.domain') ? 'company.domain' : 'company.name') : object === 'lead' ? 'lead.email' : 'contact.email';
      b.map(key, { n: Math.max(rows, 4), evidence: ['ev:self'] });
      for (const c of sample(r, kinds(mode, CORE[object]).filter((c) => c !== key), int(r, 1, 3))) b.map(c, { n: Math.max(rows, 4) });
      b.noise(chance(r, 0.5) ? 1 : 2);
      return finish({ object });
    }
    case 'CAP07': { // duplicates the source's own unique key settles: nothing to merge on a guess
      const object = pick(r, objects.filter((o) => o === 'contact' || o === 'lead'));
      const key = object === 'lead' ? 'lead.email' : 'contact.email';
      const email = b.map(key, { n: Math.max(rows, 5), evidence: ['ev:self'] });
      email.values = [...email.values.slice(0, -1), email.values[0]];
      for (const c of sample(r, kinds(mode, CORE[object]).filter((c) => c !== key), int(r, 1, 3))) b.map(c, { n: Math.max(rows, 5) });
      noise();
      return finish({ object });
    }
    case 'CAP08': { // a linking column carried on the record: the company a contact (or a lead) belongs to, by name
      const object = available(mode, 'contact.companyName') ? 'contact' : 'lead';
      const link = object === 'contact' ? 'contact.companyName' : 'lead.company';
      b.map(object === 'contact' ? 'contact.email' : 'lead.lastName', { n: rows });
      b.map(link, { n: rows });
      for (const c of sample(r, kinds(mode, CORE[object]).filter((c) => !b.columns.some((col) => col.destination === c)), int(r, 0, 2))) b.map(c, { n: rows });
      noise();
      return finish({ object, moreObjects: ['company'], tags: ['link:on-record'] });
    }
    case 'CAP09': { // columns with no destination are preserved, not forced
      const object = pick(r, objects.filter((o) => o !== 'deal'));
      const mapped = fieldsOf(object, int(r, 1, 3));
      for (const c of mapped) b.map(c, twinOf(c, mapped));
      b.noise(int(r, 2, 4));
      return finish({ object });
    }
    case 'CAP10': { // the target's required fields are supplied by the source
      const required = mode === 'SALESFORCE' ? ['contact.lastName'] : mode === 'HUBSPOT' ? ['contact.email'] : [pick(r, ['contact.email', 'contact.lastName'])];
      const extraFields = sample(r, kinds(mode, CORE.contact).filter((c) => !required.includes(c)), int(r, 1, 4));
      for (const c of [...required, ...extraFields]) b.map(c, { dirty: kindOf(c) === 'TEXT' ? dirtyText() : 'clean', ...twinOf(c, [...required, ...extraFields]) });
      noise();
      return finish({ object: 'contact', moreObjects: chance(r, 0.4) ? ['company'] : [] });
    }
    case 'CAP11': { // an address block that is consistent: city, state, postal code and country agree
      const object = pick(r, objects.filter((o) => o === 'contact' || o === 'company' || o === 'lead'));
      const block = kinds(mode, [`${object}.addressLine1`, `${object}.city`, `${object}.state`, `${object}.postalCode`, `${object}.country`]);
      const chosen = sample(r, block, Math.max(2, Math.min(block.length, int(r, 2, 5))));
      b.map(available(mode, DISCRIMINATOR[object]) ? DISCRIMINATOR[object] : block[0], {});
      for (const c of chosen) if (!b.columns.some((col) => col.destination === c)) b.map(c, {});
      noise();
      return finish({ object });
    }
    case 'CAP12': { // the header is wrong or generic; the values say what the column is (a shape the target's own type reads)
      const object = pick(r, objects.filter((o) => shapeTargets(mode, o).length > 0));
      const real = pick(r, shapeTargets(mode, object));
      const decoy = pick(r, ['Field 3', 'Column B', 'Dato', 'Info', 'Misc', 'Value', 'Campo extra', 'Wert']);
      const anchor = available(mode, DISCRIMINATOR[object]) && DISCRIMINATOR[object] !== real ? DISCRIMINATOR[object] : sample(r, kinds(mode, CORE[object]).filter((c) => c !== real), 1)[0];
      if (anchor !== undefined) b.map(anchor, {});
      b.map(real, { header: decoy, evidence: ['ev:self'], convention: false });
      noise();
      return finish({ object });
    }
    default: throw new Error(`unknown capability ${capability}`);
  }
}

/** The fields of an object whose type the planted values' shapes read without a header, in this mode (email and E.164 phone everywhere they are typed; ISO dates and integers in a vendor contract). */
function shapeTargets(mode, object) {
  const typed = mode === 'CLEAN_ONLY' ? [`${object}.email`, `${object}.phone`] : mode === 'SALESFORCE' ? [`${object}.email`, `${object}.phone`, `${object}.closeDate`, `${object}.employeeCount`, `${object}.amount`] : [`${object}.closeDate`, `${object}.employeeCount`, `${object}.amount`, `${object}.annualRevenue`];
  return availableOf(mode, typed);
}

void DATE_FORMATS;
