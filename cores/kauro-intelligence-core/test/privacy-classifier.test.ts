import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { classifyMetadataText, classifyValue, enumerationToken, fieldMayNamePeople, fieldNamesPeople, maskShape, optionListNamesPeople, vocabularyHomonym } from '../src/classifier/data-classifier.js';

const segment = { header: 'Segment', distinctCount: 2, rowCount: 10, shapeCandidates: [] };
const safe = (text: string, kind: Parameters<typeof classifyMetadataText>[1] = 'LABEL'): boolean => {
  const classification = classifyMetadataText(text, kind);
  return classification.dataClass === 'SAFE_STRUCTURAL_METADATA' && !classification.instructionLike;
};

describe('F01: metadata is classified by the same rules as values — provenance is not safety', () => {
  it('the audit reproduction: an email address as a header is personal data, not structural metadata', () => {
    assert.equal(classifyMetadataText('audit-person@example.test').dataClass, 'POTENTIAL_PII');
  });
  it('emails, phones, national ids, financial numbers, addresses and names in metadata never pass', () => {
    const personal = ['Owner alice.w@example.test', 'contact: zbigniew.k@example.test', '+34 612 345 678', 'Tel (415) 555-0134', 'DNI 12345678Z', 'Calle Mayor 12, 3ºB', '221 Baker Street', 'Alice', 'MARIA', 'María José', 'Zbigniew Kowalski', 'owner_alice', 'contactAlice'];
    for (const text of personal) assert.equal(classifyMetadataText(text).dataClass, 'POTENTIAL_PII', text);
    for (const text of ['ES9121000418450200051332', '4111 1111 1111 1111']) assert.equal(classifyMetadataText(text).dataClass, 'SENSITIVE_OR_RESTRICTED', text);
    assert.equal(classifyMetadataText(`a${String.fromCodePoint(0x202e)}b`).dataClass, 'UNKNOWN');
    assert.equal(classifyMetadataText(`Name${String.fromCodePoint(0x200b)}`).dataClass, 'UNKNOWN');
  });
  it('what is not provably structural is UNKNOWN, never SAFE', () => {
    for (const text of ['Zorblax Quux Fnord', 'Mystery 1', 'Owner: Zbigniew Kowalski', 'csv', '']) assert.notEqual(classifyMetadataText(text).dataClass, 'SAFE_STRUCTURAL_METADATA', text);
    assert.equal(classifyMetadataText('Mystery 1').dataClass, 'UNKNOWN');
    assert.equal(classifyMetadataText('x'.repeat(97)).dataClass, 'FREE_TEXT');
  });
  it('the positive allow-list keeps real headers and labels structural in five languages', () => {
    for (const text of ['First Name', 'Contact ID', 'Email', 'Phone', 'Status', 'Notes', 'Website', 'Company ID', 'Lifecycle Stage', 'Internal Score', 'Deal Stage', 'UTM Source', 'Total Amount (EUR)', 'Q1 2024', 'Revenue 2023', 'hs_object_id', 'Custom_Field__c', 'firstName', 'AccountId', 'Teléfono móvil', 'Fecha de nacimiento', 'Número de empleados', 'Nombre completo', 'Data de criação', 'Date de création', 'Erstellt am', 'Max Value', 'Bill To', 'Tax ID', 'Health condition', 'Salary']) {
      assert.ok(safe(text), text);
    }
  });
  it('identifiers: api names, object names, types and codes pass as identifiers, a person or a sentence does not', () => {
    for (const text of ['contact', 'Account', 'Internal_Score__c', 'lifecyclestage', 'enumeration', 'INVALID_SCHEMA', 'F-1a5dfa29636d', 'S0']) assert.ok(safe(text, 'IDENTIFIER'), text);
    for (const text of ['alice', 'UNKNOWN_PARAM_ALICE', 'First Name', 'ada@example.test', '12345678Z']) assert.ok(!safe(text, 'IDENTIFIER'), text);
  });
  it('options: the attested contract vouches for its enumerations, but not for a person, an email or a phone in them', () => {
    for (const text of ['lead', 'OPEN', 'Enterprise', 'Mid-Market', 'Startup', 'Won', 'lost']) assert.ok(safe(text, 'OPTION'), text);
    for (const text of ['Alice Cooper', 'Zbigniew Kowalski', 'alice@example.test', '+34 612 345 678', '12345678Z']) assert.ok(!safe(text, 'OPTION'), text);
  });
});

describe('F01: low cardinality, short length and a single word never prove absence of PII', () => {
  it('the audit reproduction: a given name in a two-value segment is PII, not safe semantics', () => {
    assert.equal(classifyValue('Alice', segment).dataClass, 'POTENTIAL_PII');
  });
  it('names by list, names by shape, homoglyphs and codes are never L1', () => {
    for (const value of ['Maria', 'MARIA', 'Zoé', 'Ada Lovelace', 'Zorblax', 'Референт', `${String.fromCodePoint(0x0410)}lice`]) assert.equal(classifyValue(value, segment).dataClass, 'POTENTIAL_PII', value);
    for (const value of ['web', 'linkedin', 'x0-1', 'Zq7#kL', 'Calle Mayor 12']) assert.notEqual(classifyValue(value, segment).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', value);
    assert.equal(classifyValue('x0-1', segment).dataClass, 'UNKNOWN');
    assert.equal(classifyValue('Calle Mayor 12', segment).dataClass, 'POTENTIAL_PII');
  });
  it('safe semantics come only from the closed vocabulary or the target options, and only at low cardinality', () => {
    for (const value of ['Active', 'true', 'ES', 'USD', '7', 'lead', 'Won', 'Pendiente', 'en cours', 'Hoch']) assert.equal(classifyValue(value, segment).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', value);
    assert.equal(classifyValue('Enterprise', segment).dataClass, 'POTENTIAL_PII');
    assert.equal(classifyValue('Enterprise', { ...segment, targetOptions: ['Enterprise', 'Startup'] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
    assert.equal(classifyValue('Alice', { ...segment, targetOptions: ['Alice'] }).dataClass, 'POTENTIAL_PII', 'an option list does not launder a name');
    assert.notEqual(classifyValue('Active', { ...segment, distinctCount: 5000, rowCount: 5000 }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
    assert.notEqual(classifyValue('Active', { ...segment, distinctCount: null }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
  });
  it('a lower-case three-letter word is not an ISO code', () => {
    assert.equal(classifyValue('ES', segment).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
    assert.notEqual(classifyValue('ivo', segment).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
    assert.notEqual(classifyValue('Ivo', segment).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
  });
});

/** Person names in scripts that have no capitals: Japanese, Chinese, Arabic, Korean, Hebrew, Thai. */
const CASELESS_NAMES = ['田中太郎', '王伟', 'محمد', '김민수', 'דוד', 'สมชาย'] as const;

describe('F01-R1: a name in a script without case is still a name', () => {
  it('the reproduction: caseless-script names at low cardinality are PII, never free text and never L1', () => {
    for (const name of CASELESS_NAMES) assert.equal(classifyValue(name, segment).dataClass, 'POTENTIAL_PII', name);
    for (const name of ['สมชาย ใจดี', 'محمد علي', 'ミラー', 'ジョン・スミス']) assert.equal(classifyValue(name, segment).dataClass, 'POTENTIAL_PII', name);
    for (const name of CASELESS_NAMES) assert.equal(classifyValue(name, { ...segment, distinctCount: 5000, rowCount: 5000 }).dataClass, 'POTENTIAL_PII', `${name} at high cardinality`);
  });
  it('as headers, labels and memory patterns they never pass; a multi-token caseless name is not an option either', () => {
    for (const name of CASELESS_NAMES) {
      assert.equal(classifyMetadataText(name).dataClass, 'POTENTIAL_PII', name);
      assert.ok(!safe(name), name);
    }
    for (const name of ['สมชาย ใจดี', 'محمد علي', 'ジョン スミス', ...CASELESS_NAMES, '山田太郎']) assert.ok(!safe(name, 'OPTION'), `${name} as an option`);
  });
  it('a caseless token is never a vetted option: the value classifier reads the list it is handed instead of trusting it', () => {
    assert.equal(classifyMetadataText('企业', 'OPTION').dataClass, 'POTENTIAL_PII', 'the OPTION channel refuses it');
    assert.equal(classifyValue('企业', { ...segment, targetOptions: ['企业', '初创'] }).dataClass, 'POTENTIAL_PII', 'so the list does not vouch for it');
    assert.equal(classifyValue('企业', segment).dataClass, 'POTENTIAL_PII');
    assert.notEqual(classifyValue('企业', { ...segment, distinctCount: null, targetOptions: ['企业'] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
  });
  it('a mask folds every script: no letter of any script and no mark survives, and a shape is its own mask', () => {
    for (const name of CASELESS_NAMES) {
      const shape = maskShape(name);
      assert.equal(shape, 'a'.repeat([...name].length), name);
      assert.ok(![...name].some((char) => shape.includes(char)), `${name} left a character in its shape`);
    }
    assert.equal(maskShape('Ada Lovelace 1815'), 'Aaa Aaaaaaaa 9999');
    assert.equal(maskShape('Референт'), 'Aaaaaaaa');
    assert.equal(maskShape('Zoë 3ºB'), 'Aaa 9aA', 'a combining mark is dropped, an ordinal letter is a letter');
    assert.equal(maskShape('田中 太郎 2024'), 'aa aa 9999');
    for (const text of ['Aaa Aaaaaaaa 9999', 'aa aa 9999', '+99 999 999 999', 'a-a']) assert.equal(maskShape(text), text, `${text} is its own mask`);
    for (const text of ['田中', 'Ab', 'a1', 'x']) assert.notEqual(maskShape(text), text, `${text} is a value, not a shape`);
  });
});

describe('F01-R2: a target field whose label names people is a list of names whatever its options look like', () => {
  it('owner, assignee, manager, representative and their translations name people; stages, industries and ownership do not', () => {
    for (const text of ['Contact Owner', 'hubspot_owner_id', 'Deal owner', 'OwnerId', 'Assigned To', 'Account Manager', 'Responsable', 'Responsável comercial', 'Sales Representative', 'Agente', '担当者', '负责人', '담당자']) assert.ok(fieldNamesPeople(text), text);
    for (const text of ['Lifecycle Stage', 'lifecyclestage', 'Industry', 'Status', 'Report Type', 'Ownership', 'Agency', 'Segment']) assert.ok(!fieldNamesPeople(text), text);
    assert.ok(fieldNamesPeople('Lifecycle Stage', 'hubspot_owner_id'), 'either text is enough');
  });
});

describe('IC-05: being an option of the target never widens the classes a value may travel in', () => {
  const status = { header: 'Status', distinctCount: 1, rowCount: 4, shapeCandidates: [] };
  const NAMES = ['Zuleika', 'Svetlana', 'Kowalski', 'Petrova', 'Ivanov', 'Popescu', 'Andersson', 'Jensen', 'Fernández', 'Mohammed', 'Ayşe', 'Agnieszka', 'Priya', 'Hiroshi', '山田太郎', 'Ada Lovelace'] as const;
  it('the reproduction: a single personal name of any language fails the OPTION channel and is PII as a value, option list or not', () => {
    for (const name of NAMES) {
      assert.ok(!safe(name, 'OPTION'), `${name} as an option`);
      assert.equal(classifyValue(name, { ...status, targetOptions: [name] }).dataClass, 'POTENTIAL_PII', `${name} as a value the option list names`);
    }
  });
  it('the control: genuine enumerations pass the OPTION channel and travel as L1 by it', () => {
    for (const option of ['Active', 'lead', 'OPEN', 'Enterprise', 'Startup', 'Mid-Market', 'Won', 'Person', 'Nova', 'Season', 'Open', 'Closed']) assert.ok(safe(option, 'OPTION'), option);
    assert.equal(classifyValue('Active', { ...status, targetOptions: ['Active'] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
    assert.equal(classifyValue('Enterprise', { ...status, targetOptions: ['Enterprise', 'Startup'] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
    assert.equal(classifyValue('Person', { ...status, targetOptions: ['Person', 'Company'] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', 'a vocabulary word with a name-like ending is a word');
  });
});

/** The reviewer's S3 sentinels: single-token person names in Basque Latin, Cyrillic, Georgian, Greek and unlisted Latin, none of them in GIVEN_NAMES. */
const S3_NAMES = ['Iker', 'Unai', 'Ainhoa', 'Leire', 'Светлана', 'Дмитрий', 'Ольга', 'გიორგი', 'ნინო', 'დავითი', 'Γιώργος', 'Μαρία', 'Νίκος', 'Zbigniew', 'Okonkwo', 'Thandiwe'] as const;

describe('R2-PC-01: an option travels only when it is provably an enumeration token; the label adds restrictions, never permissions', () => {
  const segmentOf = (options: readonly string[]) => ({ header: 'Segment', distinctCount: options.length, rowCount: 8, shapeCandidates: [], targetOptions: options });
  it('the reproduction: a single-token name of any script fails the OPTION channel as a proper noun and vouches for nothing', () => {
    for (const name of S3_NAMES) {
      const option = classifyMetadataText(name, 'OPTION');
      assert.equal(option.dataClass, 'POTENTIAL_PII', `${name} as an option`);
      assert.ok(option.reason.includes('proper noun'), `${name}: ${option.reason}`);
      assert.ok(!enumerationToken(name), `${name} is not an enumeration token`);
      assert.equal(classifyValue(name, segmentOf([...S3_NAMES])).dataClass, 'POTENTIAL_PII', `${name} as a value the option list names`);
      assert.notEqual(classifyValue(name, segmentOf([name])).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${name} alone in the list`);
    }
  });
  it('case, script and spelling tricks do not make a name an enumeration: lower case, upper case, hyphenated, Pascal-cased, snake-cased', () => {
    for (const text of ['iker', 'LEIRE', 'OKONKWO', 'Iker-Unai', 'iker_unai', 'McDonald', 'DiCaprio', 'JoAnn', 'Ainhoa.Leire', 'Thandiwe (Sales)', 'Светлана Иванова', 'Ολγα', 'ольга']) {
      assert.ok(!safe(text, 'OPTION'), `${text} as an option`);
      assert.ok(!enumerationToken(text), `${text} as an enumeration token`);
    }
  });
  it('what is neither a word nor a name is UNKNOWN, still not safe', () => {
    for (const text of ['Zorblax Quux', 'Iker & Unai', '???']) {
      const option = classifyMetadataText(text, 'OPTION');
      assert.notEqual(option.dataClass, 'SAFE_STRUCTURAL_METADATA', text);
    }
    assert.equal(classifyMetadataText('Zorblax Quux', 'OPTION').dataClass, 'POTENTIAL_PII', 'two capitalised words are a name');
    assert.equal(classifyMetadataText('zorblax quux', 'OPTION').dataClass, 'UNKNOWN');
  });
  it('the positives: the enumerations CRMs ship with pass — vocabulary words, codes, integers, compounds of vocabulary words — under any label', () => {
    const enumerations = [
      'Enterprise', 'Startup', 'SMB', 'SME', 'PYME', 'Mid-Market', 'Corporate', 'Small', 'Medium', 'Large', 'Unassigned',
      'Active', 'Inactive', 'Open', 'Closed', 'Won', 'Lost', 'New', 'Pending', 'lead', 'OPEN', 'Person', 'Nova', 'Season',
      'Closed Won', 'Closed Lost', 'Marketing Qualified Lead', 'Sales Qualified Lead', 'Opportunity', 'Customer', 'Evangelist', 'Subscriber', 'Other',
      'Open - Not Contacted', 'Working - Contacted', 'Closed - Converted', 'Closed - Not Converted',
      'Prospecting', 'Qualification', 'Needs Analysis', 'Value Proposition', 'Id. Decision Makers', 'Perception Analysis', 'Proposal/Price Quote', 'Negotiation/Review',
      'Contact Made', 'Demo Scheduled', 'Proposal Made', 'Negotiations Started', 'Attempted to Contact', 'Contact in Future', 'Junk Lead', 'Pre-Qualified', 'Not Qualified',
      'In Progress', 'en cours', 'En attente', 'Alta', 'Baja', 'Gold', 'Silver', 'Premium', 'Free', 'Monthly', 'Yearly', 'Trade Show', 'Real Estate', 'Healthcare', 'Inbound', 'Outbound',
      'B2B', 'B2C', '1-10', '11-50', '51-200', '1', '42', 'Q1', 'ES', 'USD', 'A', 'opt_in', 'closed_won', 'ClosedWon', 'inProgress', 'Tier 1', 'Level 2', 'Custom_Stage__c', 'N/A', 'Team A',
    ];
    for (const option of enumerations) {
      assert.ok(safe(option, 'OPTION'), `${option} as an option`);
      assert.ok(enumerationToken(option), `${option} as an enumeration token`);
    }
    assert.equal(classifyValue('Enterprise', segmentOf(['Enterprise', 'Startup'])).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
    assert.equal(classifyValue('Unassigned', segmentOf(['Unassigned', 'Zbigniew'])).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', 'the enumeration in a list that also holds a name still vouches for itself');
    assert.equal(classifyValue('Zbigniew', segmentOf(['Unassigned', 'Zbigniew'])).dataClass, 'POTENTIAL_PII', 'and the name in it is still a name');
  });
  it('the person-field vocabulary is a restriction only: a label it does not name grants no option anything it did not have', () => {
    for (const label of ['Comercial', 'Vendedor', 'Sales Rep', 'Менеджер', 'Status', 'Segment']) assert.ok(!fieldNamesPeople(label), `${label} is outside the vocabulary`);
    for (const name of S3_NAMES) assert.ok(!safe(name, 'OPTION'), `${name} under a label the vocabulary does not name`);
  });
});

/** The reviewer's short upper-case surnames: two or three capitals with the shape of an ISO code and no place in any code list. */
const SHORT_UPPER_SURNAMES = ['LEE', 'WU', 'KIM', 'HO', 'LIM', 'TAN', 'LAU', 'YIP', 'CHO', 'MAK', 'FOO', 'NGO', 'LIU', 'XU'] as const;

describe('R2R-PC-01: two or three capitals are a code only when the closed ISO lists know them; the shape alone is nothing', () => {
  const column = { header: 'Segment', distinctCount: 3, rowCount: 12, shapeCandidates: [] };
  it('the reproduction: LEE, WU, KIM and their kind never travel — not as a value, not by an option list that names them, not as an option', () => {
    for (const token of SHORT_UPPER_SURNAMES) {
      assert.notEqual(classifyValue(token, column).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${token} as a value`);
      assert.notEqual(classifyValue(token, { ...column, targetOptions: [token] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${token} as a value the option list names`);
      assert.ok(!safe(token, 'OPTION'), `${token} as an option`);
      assert.ok(!enumerationToken(token), `${token} as an enumeration token`);
    }
    // Not a shape either: a code or a surname, nothing tells which, so the token is UNKNOWN and the column closes.
    assert.equal(classifyValue('LEE', column).dataClass, 'UNKNOWN');
    assert.equal(classifyValue('LEE', { ...column, distinctCount: 5000, rowCount: 5000 }).dataClass, 'UNKNOWN', 'at any cardinality');
    assert.equal(classifyMetadataText('LEE', 'OPTION').dataClass, 'UNKNOWN');
    assert.equal(classifyValue('KIM', column).dataClass, 'POTENTIAL_PII', 'a given name that has the shape is a name first');
    assert.equal(classifyValue('LEE', { header: '', distinctCount: 1, rowCount: 1, shapeCandidates: [], targetOptions: ['LEE'] }).dataClass, 'UNKNOWN', 'the egress re-read of a forged L1 refuses it against its own option');
  });
  it('the positives: ISO 3166 alpha-2 and alpha-3 country codes and ISO 4217 currency codes travel as values and options, case-sensitively', () => {
    for (const code of ['US', 'ES', 'GB', 'DE', 'MX', 'BR', 'FR', 'PT', 'LI', 'NG', 'UK', 'EU', 'ESP', 'USA', 'DEU', 'BRA', 'GBR', 'MEX', 'EUR', 'USD', 'GBP', 'MXN', 'BRL', 'CHF', 'JPY', 'XAU']) {
      assert.equal(classifyValue(code, column).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${code} as a value`);
      assert.ok(safe(code, 'OPTION'), `${code} as an option`);
    }
    for (const word of ['us', 'Es', 'eur', 'Usd']) assert.notEqual(classifyValue(word, column).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${word} is a word, not a code`);
    assert.equal(classifyValue('BEN', column).dataClass, 'POTENTIAL_PII', 'a code that is also a given name is the name');
  });
  it('a short upper-case token the target vouches for still travels by the option, as the vocabulary does: SMB, VIP, OK', () => {
    for (const token of ['SMB', 'VIP']) {
      assert.ok(safe(token, 'OPTION'), `${token} as an option`);
      assert.equal(classifyValue(token, { ...column, targetOptions: [token] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${token} vouched`);
      assert.equal(classifyValue(token, column).dataClass, 'UNKNOWN', `${token} alone`);
    }
    assert.equal(classifyValue('OK', column).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS');
  });
});

describe('R2R-PC-02: a token that carries a digit is a code in capitals or as a vocabulary word beside a number; a handle is not', () => {
  const column = { header: 'Segment', distinctCount: 3, rowCount: 12, shapeCandidates: [] };
  const HANDLES = ['zuleika7', 'jkowalski1', 'mlopez01', 'agarcia2', 'svetlana99', 'okonkwo3', 'ZULEIKA7', 'Kowalski7', 'zuleika_7', 'j.kowalski1', 'm-lopez01'] as const;
  it('the reproduction: name-derived handles never travel — not as an option, not as a value the option list names', () => {
    for (const handle of HANDLES) {
      assert.ok(!safe(handle, 'OPTION'), `${handle} as an option`);
      assert.ok(!enumerationToken(handle) || classifyMetadataText(handle, 'OPTION').dataClass === 'POTENTIAL_PII', `${handle} as an enumeration token`);
      assert.notEqual(classifyValue(handle, column).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${handle} as a value`);
      assert.notEqual(classifyValue(handle, { ...column, targetOptions: [handle] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${handle} as a value the option list names`);
    }
    for (const handle of ['zuleika7', 'ZULEIKA7', 'Kowalski7', 'svetlana99']) {
      assert.equal(classifyValue(handle, { ...column, targetOptions: [handle] }).dataClass, 'POTENTIAL_PII', `${handle}: the letters beside the digits are a name`);
      assert.equal(classifyMetadataText(handle, 'OPTION').dataClass, 'POTENTIAL_PII', `${handle} as an option is a name`);
    }
    // Revision 009 (data policy 1.5.0): a handle no name list knows was UNKNOWN in round 4 — refused, but by
    // omission. Under the new contract an unknown letter run beside a digit is a handle and a handle is personal
    // on every channel, whatever its case, length or digit-to-letter ratio; UNKNOWN is kept for what the rule
    // has no reading of at all (LEE, WU), never for a handle it declined to read.
    for (const handle of ['jkowalski1', 'mlopez01', 'okonkwo3']) {
      assert.equal(classifyValue(handle, { ...column, targetOptions: [handle] }).dataClass, 'POTENTIAL_PII', `${handle}: a handle no list knows is personal, never merely unknown`);
      assert.equal(classifyMetadataText(handle, 'OPTION').dataClass, 'POTENTIAL_PII', `${handle} as an option`);
    }
  });
  it('the positives: codes in capitals, digit-dominant tokens and vocabulary words beside a number pass the OPTION channel and vouch for the identical value', () => {
    for (const code of ['A12', 'SKU-0042', '2024Q1', '001', 'B2B', 'Q1', '1-10', '51-200', 'ISO-9001', 'PO_2024/07', 'a12', '4b', 'tier1', 'phone2', 'level3', 'Tier2', 'nivel1']) {
      assert.ok(safe(code, 'OPTION'), `${code} as an option`);
      assert.ok(enumerationToken(code), `${code} as an enumeration token`);
      assert.equal(classifyValue(code, { ...column, targetOptions: [code] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${code} vouched by the option`);
    }
    assert.equal(classifyValue('001', column).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', 'a small integer is safe vocabulary on its own');
    assert.equal(classifyValue('A12', column).dataClass, 'UNKNOWN', 'a code with no option behind it is not L1 by shape');
  });
  it('a header that is a handle is read the same way: the letters beside the digits are the name', () => {
    for (const header of ['zuleika7', 'Owner svetlana99', 'Kowalski7']) assert.equal(classifyMetadataText(header).dataClass, 'POTENTIAL_PII', header);
    for (const header of ['Address 2', 'phone2', 'Q1 2024', 'hs_object_id']) assert.ok(safe(header), header);
  });
});

describe('R2R-PC-03: a vocabulary word that is also a surname is told apart by the list it stands in and the label over it', () => {
  it('the homonyms: a single capitalised word in both the enumeration vocabulary and the surname list; a plain word or a plain name is not one', () => {
    for (const word of ['Klein', 'Petit', 'Gross', 'Grand', 'Small', 'Price', 'Fields', 'Banks', 'Day', 'Gold', 'Silver', 'Campos', 'Casas', 'Fuentes', 'Chance', 'Plata', 'KLEIN', 'PRICE']) assert.ok(vocabularyHomonym(word), word);
    for (const text of ['Enterprise', 'Startup', 'Active', 'Medium', 'Smith', 'García', 'Zbigniew', 'klein', 'Klein Gross', 'Mid-Market', '']) assert.ok(!vocabularyHomonym(text), text);
  });
  it('a list holds a name when the OPTION channel refuses one of its options as a proper noun; a list of words does not', () => {
    assert.ok(optionListNamesPeople(['Klein', 'Petit', 'Zbigniew']));
    assert.ok(optionListNamesPeople(['Price', 'Campos', 'García']));
    assert.ok(optionListNamesPeople(['Small', 'Светлана']));
    assert.ok(!optionListNamesPeople(['Klein', 'Gross', 'Mittel']));
    assert.ok(!optionListNamesPeople(['Small', 'Medium', 'Large']));
    assert.ok(!optionListNamesPeople(['Gold', 'Silver', 'Bronze']));
    assert.ok(!optionListNamesPeople([]));
  });
  it('a label may name people beyond the person-field vocabulary: sellers, users, authors, members, contacts; stages, segments and sizes may not', () => {
    for (const label of ['Comercial', 'Vendedor', 'Sales Rep', 'Менеджер', 'Created by', 'Modificado por', 'Account Executive', 'Usuario', 'Contact', 'Member', 'Deal owner', 'hubspot_owner_id']) assert.ok(fieldMayNamePeople(label), label);
    for (const label of ['Lifecycle Stage', 'lifecyclestage', 'Segment', 'Company Size', 'Tier', 'Industry', 'Status', 'Priority']) assert.ok(!fieldMayNamePeople(label), label);
    assert.ok(!fieldNamesPeople('Comercial'), 'the wider vocabulary does not widen the person-field one: it is read for the tie-break only');
  });
});
