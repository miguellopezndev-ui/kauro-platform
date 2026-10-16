// Shared planting kit for the fixture templates (B04-FIXTURES). Everything here PLANTS: names, headers, values,
// target universes, noise. Nothing runs IC; the truth a template states is its own decision about what it planted.
// All data is synthetic: invented names built from syllables, example.test addresses, fictional phone ranges
// (+1 ... 555 01xx, +44 7700 900xxx), invented companies on reserved test domains.
import { CANONICAL_FIELDS, getAdapter } from 'kauro-migration-core';
import { shapesOf } from './bind.mjs';

export const MODES = Object.freeze(['CLEAN_ONLY', 'HUBSPOT', 'SALESFORCE']);
export const noGates = Object.freeze({ identityUnproven: false, injectionSentinels: [], foreignRefs: [], secretSentinels: [], safetyCritical: false });

// ------------------------------------------------------------------ randomness
export function rngOf(seed) {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const pick = (r, list) => list[Math.floor(r() * list.length)];
export const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
export const chance = (r, p) => r() < p;
export function sample(r, list, n) {
  const pool = [...list]; const out = [];
  while (out.length < n && pool.length > 0) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}
export const shuffle = (r, list) => sample(r, list, list.length);

// --------------------------------------------------------------- invented people
const SYL_A = ['tav', 'mes', 'orv', 'bel', 'zer', 'pel', 'quel', 'dar', 'fin', 'hal', 'jor', 'kes', 'lum', 'nor', 'ris', 'sov', 'tul', 'vex', 'wil', 'yan'];
const SYL_B = ['orin', 'aly', 'anth', 'quist', 'enko', 'sorin', 'mar', 'dell', 'vik', 'rane', 'ova', 'ell', 'iko', 'unda', 'ero', 'ath'];
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
export const firstName = (r) => cap(pick(r, SYL_A) + pick(r, ['a', 'o', 'el', 'an', 'is', 'ia', 'ek']));
export const lastName = (r) => cap(pick(r, SYL_A) + pick(r, SYL_B));
const ascii = (text) => text.normalize('NFKD').replace(/[^\x00-\x7f]/gu, '').toLowerCase();
export const COMPANY_SUFFIX = ['Ltd', 'S.L.', 'GmbH', 'SAS', 'LLC', 'B.V.', 'S.A.', 'Inc.'];
export const companyName = (r) => `${cap(pick(r, SYL_A))}${pick(r, SYL_B)} ${pick(r, ['Labs', 'Works', 'Partners', 'Group', 'Studio', 'Systems', 'Foods', 'Logistics'])} ${pick(r, COMPANY_SUFFIX)}`;
export const domainOf = (name) => `${ascii(name).replace(/\s+(ltd|s\.l\.|gmbh|sas|llc|b\.v\.|s\.a\.|inc\.)$/u, '').replace(/[^a-z0-9]+/gu, '-')}.test`;
export const emailOf = (r, i) => `${ascii(firstName(r))}.${ascii(lastName(r))}${String(i)}@${pick(r, ['example.test', 'corp.example.test', 'sample.invalid'])}`;
export const phoneOf = (r, style = 'e164') => {
  const tail = String(100 + int(r, 0, 99));
  const uk = chance(r, 0.35);
  const digits = uk ? `7700 900${String(int(r, 100, 999))}` : tail;
  if (style === 'e164') return uk ? `+44${digits.replace(' ', '')}` : `+1202555${'0'}${tail}`;
  const variants = uk ? [`+44 ${digits}`, `+44-7700-900-${digits.slice(-3)}`] : [`+1 202 555 0${tail}`, `(202) 555-0${tail}`, `202.555.0${tail}`, `+1-202-555-0${tail}`];
  return pick(r, variants);
};
const pad2 = (n) => String(n).padStart(2, '0');
const MONTHS = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] };
/** A date whose day is above 12, so its reading is never ambiguous, in one named format. */
export function dateIn(r, format) {
  const y = int(r, 2018, 2026); const m = int(r, 1, 9); const d = int(r, 13, 28);
  switch (format) {
    case 'ISO_8601': return `${String(y)}-${pad2(m)}-${pad2(d)}`;
    case 'DD/MM/YYYY': return `${pad2(d)}/${pad2(m)}/${String(y)}`;
    case 'MM/DD/YYYY': return `${pad2(m)}/${pad2(d)}/${String(y)}`;
    case 'DD.MM.YYYY': return `${pad2(d)}.${pad2(m)}.${String(y)}`;
    case 'DD-MM-YYYY': return `${pad2(d)}-${pad2(m)}-${String(y)}`;
    case 'YYYY/MM/DD': return `${String(y)}/${pad2(m)}/${pad2(d)}`;
    default: return `${String(d)} ${MONTHS.en[m - 1]} ${String(y)}`;
  }
}
export const DATE_FORMATS = Object.freeze(['ISO_8601', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY', 'DD-MM-YYYY', 'YYYY/MM/DD']);

// ------------------------------------------------------------------ language packs
export const LANGS = Object.freeze(['en', 'es', 'de', 'fr', 'pt', 'it', 'nl', 'ja', 'zh', 'ko', 'ru', 'ar', 'he', 'tr', 'pl', 'el', 'hi', 'th', 'sv', 'vi']);
export const LATIN_LANGS = Object.freeze(['en', 'es', 'de', 'fr', 'pt', 'it']);
// key order: email, first, last, phone, mobile, company, city, country, zip, title, created, stage, amount, website, address
const KEYS = ['email', 'first', 'last', 'phone', 'mobile', 'company', 'city', 'country', 'zip', 'title', 'created', 'stage', 'amount', 'website', 'address'];
const PACK = {
  en: 'Email|First name|Last name|Phone|Mobile|Company|City|Country|Postal code|Job title|Created|Stage|Amount|Website|Street address',
  es: 'Correo electrónico|Nombre|Apellidos|Teléfono|Móvil|Empresa|Ciudad|País|Código postal|Cargo|Fecha de alta|Etapa|Importe|Sitio web|Dirección',
  de: 'E-Mail-Adresse|Vorname|Nachname|Telefon|Mobil|Firma|Stadt|Land|PLZ|Position|Erstellt am|Phase|Betrag|Webseite|Straße',
  fr: 'Adresse courriel|Prénom|Nom de famille|Téléphone|Portable|Société|Ville|Pays|Code postal|Fonction|Date de création|Étape|Montant|Site web|Adresse',
  pt: 'E-mail|Primeiro nome|Sobrenome|Telefone|Celular|Empresa|Cidade|País|CEP|Cargo|Data de criação|Etapa|Valor|Site|Endereço',
  it: 'Indirizzo email|Nome|Cognome|Telefono|Cellulare|Azienda|Città|Paese|CAP|Ruolo|Data di creazione|Fase|Importo|Sito web|Indirizzo',
  nl: 'E-mailadres|Voornaam|Achternaam|Telefoon|Mobiel|Bedrijf|Stad|Land|Postcode|Functie|Aanmaakdatum|Fase|Bedrag|Website|Adres',
  ja: 'メールアドレス|名|姓|電話番号|携帯電話|会社名|市区町村|国|郵便番号|役職|登録日|ステージ|金額|ウェブサイト|住所',
  zh: '电子邮件|名字|姓氏|电话|手机|公司|城市|国家|邮政编码|职位|创建日期|阶段|金额|网站|地址',
  ko: '이메일|이름|성|전화번호|휴대전화|회사|도시|국가|우편번호|직책|등록일|단계|금액|웹사이트|주소',
  ru: 'Электронная почта|Имя|Фамилия|Телефон|Мобильный|Компания|Город|Страна|Индекс|Должность|Дата создания|Этап|Сумма|Сайт|Адрес',
  ar: 'البريد الإلكتروني|الاسم الأول|اسم العائلة|الهاتف|الجوال|الشركة|المدينة|الدولة|الرمز البريدي|المسمى الوظيفي|تاريخ الإنشاء|المرحلة|المبلغ|الموقع|العنوان',
  he: 'דוא״ל|שם פרטי|שם משפחה|טלפון|נייד|חברה|עיר|מדינה|מיקוד|תפקיד|תאריך יצירה|שלב|סכום|אתר|כתובת',
  tr: 'E-posta|Ad|Soyad|Telefon|Cep telefonu|Şirket|Şehir|Ülke|Posta kodu|Unvan|Oluşturma tarihi|Aşama|Tutar|Web sitesi|Adres',
  pl: 'Adres e-mail|Imię|Nazwisko|Telefon|Komórka|Firma|Miasto|Kraj|Kod pocztowy|Stanowisko|Data utworzenia|Etap|Kwota|Strona internetowa|Adres',
  el: 'Ηλεκτρονικό ταχυδρομείο|Όνομα|Επώνυμο|Τηλέφωνο|Κινητό|Εταιρεία|Πόλη|Χώρα|Τ.Κ.|Θέση|Ημερομηνία δημιουργίας|Στάδιο|Ποσό|Ιστότοπος|Διεύθυνση',
  hi: 'ईमेल|पहला नाम|उपनाम|फ़ोन|मोबाइल|कंपनी|शहर|देश|पिन कोड|पद|निर्माण तिथि|चरण|राशि|वेबसाइट|पता',
  th: 'อีเมล|ชื่อ|นามสกุล|โทรศัพท์|มือถือ|บริษัท|เมือง|ประเทศ|รหัสไปรษณีย์|ตำแหน่ง|วันที่สร้าง|ขั้นตอน|จำนวนเงิน|เว็บไซต์|ที่อยู่',
  sv: 'E-postadress|Förnamn|Efternamn|Telefon|Mobil|Företag|Stad|Land|Postnummer|Titel|Skapad|Fas|Belopp|Webbplats|Adress',
  vi: 'Email|Tên|Họ|Điện thoại|Di động|Công ty|Thành phố|Quốc gia|Mã bưu chính|Chức danh|Ngày tạo|Giai đoạn|Số tiền|Trang web|Địa chỉ',
};
export const HEADERS = Object.fromEntries(Object.entries(PACK).map(([lang, line]) => [lang, Object.fromEntries(line.split('|').map((text, i) => [KEYS[i], text]))]));
// Headers that need only English (and a few languages).
const EXTRA = { domain: { en: 'Domain', es: 'Dominio', de: 'Domäne', fr: 'Domaine', pt: 'Domínio', it: 'Dominio' }, employees: { en: 'Employees', es: 'Empleados', de: 'Mitarbeiter', fr: 'Employés', pt: 'Funcionários', it: 'Dipendenti' }, revenue: { en: 'Annual revenue', es: 'Facturación anual', de: 'Jahresumsatz', fr: "Chiffre d'affaires", pt: 'Faturamento anual', it: 'Fatturato annuo' }, industry: { en: 'Industry', es: 'Sector', de: 'Branche', fr: 'Secteur', pt: 'Setor', it: 'Settore' }, dealName: { en: 'Deal name', es: 'Oportunidad', de: 'Geschäft', fr: 'Affaire', pt: 'Negócio', it: 'Trattativa' }, closeDate: { en: 'Close date', es: 'Fecha de cierre', de: 'Abschlussdatum', fr: 'Date de clôture', pt: 'Data de fechamento', it: 'Data di chiusura' }, state: { en: 'State', es: 'Provincia', de: 'Bundesland', fr: 'Région', pt: 'Estado', it: 'Provincia' }, source: { en: 'Lead source', es: 'Origen del contacto', de: 'Quelle', fr: 'Origine du contact', pt: 'Origem do lead', it: 'Origine' }, status: { en: 'Status', es: 'Estado del contacto', de: 'Kontaktstatus', fr: 'Statut du contact', pt: 'Situação', it: 'Stato del contatto' }, currency: { en: 'Currency', es: 'Moneda', de: 'Währung', fr: 'Devise', pt: 'Moeda', it: 'Valuta' }, consent: { en: 'Do not email', es: 'No enviar correo', de: 'Keine E-Mails', fr: 'Ne pas écrire', pt: 'Não enviar e-mail', it: 'Non inviare email' }, callconsent: { en: 'Do not call', es: 'No llamar', de: 'Nicht anrufen', fr: 'Ne pas appeler', pt: 'Não ligar', it: 'Non chiamare' } };
export const headerFor = (key, lang) => HEADERS[lang]?.[key] ?? EXTRA[key]?.[lang] ?? EXTRA[key]?.en ?? HEADERS.en[key] ?? key;

// ------------------------------------------------------------------ target universe
const adapterFields = new Map(); // mode -> Map(canonical -> { object, required })
function fieldTable(mode) {
  if (!adapterFields.has(mode)) {
    const table = new Map();
    for (const spec of getAdapter(mode).objects) for (const f of spec.fields) table.set(f.canonicalField, { object: spec.object.toLowerCase(), required: spec.requiredForCreate.includes(f.canonicalField) });
    adapterFields.set(mode, table);
  }
  return adapterFields.get(mode);
}
export const available = (mode, canonical) => fieldTable(mode).has(canonical);
export const availableOf = (mode, list) => list.filter((canonical) => available(mode, canonical));
export const objectsOf = (mode) => [...new Set([...fieldTable(mode).values()].map((entry) => entry.object))];
export const allFields = (mode) => [...fieldTable(mode).keys()];

/** The concept of each canonical field: value class and semantic type of the data it holds. */
const CLASS = { EMAIL: ['EMAIL', 'EMAIL'], PHONE: ['PHONE', 'PHONE'], TEXT: ['TEXT', 'TEXT'], DATE: ['DATE', 'DATE'], NUMBER: ['NUMBER', 'NUMBER'], ENUM: ['ENUM', 'ENUM'], BOOLEAN: ['BOOLEAN', 'BOOLEAN'], URL: ['TEXT', 'URL'] };
const KIND = {
  'contact.email': 'EMAIL', 'lead.email': 'EMAIL', 'contact.phone': 'PHONE', 'contact.mobilePhone': 'PHONE', 'lead.phone': 'PHONE', 'lead.mobilePhone': 'PHONE', 'company.phone': 'PHONE',
  'contact.createdAt': 'DATE', 'lead.createdAt': 'DATE', 'deal.closeDate': 'DATE', 'deal.amount': 'NUMBER', 'company.employeeCount': 'NUMBER', 'company.annualRevenue': 'NUMBER', 'lead.employeeCount': 'NUMBER', 'lead.annualRevenue': 'NUMBER',
  'contact.lifecycleStage': 'ENUM', 'deal.stage': 'ENUM', 'lead.status': 'ENUM', 'lead.leadSource': 'ENUM', 'lead.rating': 'ENUM', 'contact.doNotEmail': 'BOOLEAN', 'contact.doNotCall': 'BOOLEAN', 'lead.doNotEmail': 'BOOLEAN', 'lead.doNotCall': 'BOOLEAN', 'contact.marketingConsent': 'BOOLEAN',
  'contact.website': 'URL', 'company.website': 'URL', 'lead.website': 'URL', 'company.domain': 'URL',
};
export const kindOf = (canonical) => KIND[canonical] ?? 'TEXT';
export const classOf = (canonical) => CLASS[kindOf(canonical)][0];
export const semanticOf = (canonical) => CLASS[kindOf(canonical)][1];
const HEADER_KEY = {
  email: 'email', first: 'first', last: 'last', phone: 'phone', mobilePhone: 'mobile', companyName: 'company', company: 'company', name: 'company', city: 'city', country: 'country', postalCode: 'zip', jobTitle: 'title', createdAt: 'created',
  lifecycleStage: 'stage', stage: 'stage', amount: 'amount', website: 'website', addressLine1: 'address', domain: 'domain', employeeCount: 'employees', annualRevenue: 'revenue', industry: 'industry', closeDate: 'closeDate', state: 'state', leadSource: 'source', status: 'status', currency: 'currency', doNotEmail: 'consent', doNotCall: 'callconsent', firstName: 'first', lastName: 'last',
};
export function headerOfField(canonical, lang) {
  const [object, name] = canonical.split('.');
  if (canonical === 'deal.name') return headerFor('dealName', lang);
  if (object === 'company' && name === 'name') return headerFor('company', lang);
  if (HEADER_KEY[name] === undefined && EXTRA[name] === undefined) return cap(name.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase());
  return headerFor(HEADER_KEY[name] ?? name, lang);
}

const HUBSPOT_LIFECYCLE = ['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer', 'evangelist', 'other'];
const SALESFORCE_LEAD_STATUS = ['Open - Not Contacted', 'Working - Contacted', 'Closed - Converted', 'Closed - Not Converted'];
const DEAL_STAGES = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
/**
 * What each closed safe word of a source status column means in a vendor picklist: the option an agency's own reading of the word
 * puts it in (D3-CAP-05, D4-SCORE-9). Planted by the template, never read back from a run; a word with no clear option of a field is
 * not planted in a column that maps to it.
 */
// The options the privacy layer shows a run are what a mapping can reach: HubSpot's marketing- and sales-qualified lifecycle stages are withheld from the request (PII classifier on vocabulary), so no word is planted to mean them.
export const SAFE_ENUM_MAP = Object.freeze({
  'contact.lifecycleStage': { new: 'lead', open: 'lead', pending: 'opportunity', qualified: 'opportunity', won: 'customer', active: 'customer', lost: 'other', inactive: 'other' },
  'lead.status': { new: 'Open - Not Contacted', open: 'Open - Not Contacted', pending: 'Working - Contacted', active: 'Working - Contacted', qualified: 'Working - Contacted', won: 'Closed - Converted', lost: 'Closed - Not Converted', inactive: 'Closed - Not Converted' },
  'deal.stage': { new: 'Prospecting', open: 'Prospecting', qualified: 'Qualification', pending: 'Negotiation', active: 'Negotiation', won: 'Closed Won', lost: 'Closed Lost', inactive: 'Closed Lost' },
});
export function optionsOf(mode, canonical) {
  if (mode === 'CLEAN_ONLY') return undefined;
  if (canonical === 'contact.lifecycleStage') return HUBSPOT_LIFECYCLE;
  if (canonical === 'lead.status') return SALESFORCE_LEAD_STATUS;
  if (canonical === 'deal.stage') return DEAL_STAGES;
  return undefined;
}

/**
 * The target universe a template plants: the used fields, the destination's required fields of the objects involved,
 * and `extra` further fields of those objects or of `moreObjects` (decoys the run must not touch).
 */
export function universeOf(r, mode, used, { extra = 0, moreObjects = [], labels = {}, options = {}, custom = [], supplied = null } = {}) {
  const table = fieldTable(mode);
  const objects = new Set([...used.map((c) => c.split('.')[0]), ...moreObjects]);
  if (objects.size === 0) objects.add('contact');
  const names = new Set(used);
  for (const [canonical, info] of table) if (objects.has(info.object) && info.required) names.add(canonical);
  const pool = [...table.keys()].filter((c) => objects.has(c.split('.')[0]) && !names.has(c));
  for (const c of sample(r, pool, Math.min(names.size === 0 ? Math.max(extra, 3) : extra, pool.length))) names.add(c);
  const byObject = new Map();
  for (const canonical of [...names].sort()) {
    const [object, name] = canonical.split('.');
    if (!byObject.has(object)) byObject.set(object, []);
    const opts = options[canonical] ?? optionsOf(mode, canonical);
    // A field the destination requires is planted required only where the source supplies it (or the template plants the gap): a
    // requirement no column can meet is its own question (CAP10), not a hazard every fixture of the object carries by accident.
    const required = (table.get(canonical)?.required ?? false) && (supplied === null || supplied.has(canonical));
    byObject.get(object).push({ name, valueClass: classOf(canonical), required, ...(labels[canonical] === undefined ? {} : { label: labels[canonical] }), ...(opts === undefined ? {} : { options: opts }) });
  }
  // Contract-only fields the destination does not deliver (custom properties): never a valid home for a source column.
  for (const field of custom) { if (!byObject.has(field.object)) byObject.set(field.object, []); byObject.get(field.object).push({ name: field.name, valueClass: field.valueClass ?? 'TEXT', required: false, ...(field.label === undefined ? {} : { label: field.label }), ...(field.externalId === true ? { externalId: true } : {}) }); }
  // Migration Core 3.0.0 delivers a custom: field only to a property the attested contract declares. The corpus's read configuration
  // delivers each record's id to custom:source_id (bind.mjs), so every object of a vendor mode declares that property, as a customer
  // who created it would: a contract-only field no source column belongs in.
  if (mode !== 'CLEAN_ONLY') for (const fields of byObject.values()) if (!fields.some((field) => field.name === 'source_id')) fields.push({ name: 'source_id', valueClass: 'TEXT', required: false });
  return [...byObject].map(([name, fields]) => ({ name, fields }));
}

// ------------------------------------------------------------------ value generation
export const STAGE_WORDS = {
  en: [['lead', 'prospect', 'client', 'ex-client', 'partner', 'churned'], ['new', 'contacted', 'qualified', 'customer', 'lost', 'dormant']],
  es: [['potencial', 'cliente', 'ex-cliente', 'proveedor', 'baja'], ['nuevo', 'contactado', 'cualificado', 'ganado', 'perdido']],
  de: [['Interessent', 'Kunde', 'Ex-Kunde', 'Partner'], ['neu', 'kontaktiert', 'qualifiziert', 'gewonnen', 'verloren']],
  fr: [['prospect', 'client', 'ancien client', 'partenaire'], ['nouveau', 'contacté', 'qualifié', 'gagné', 'perdu']],
  pt: [['potencial', 'cliente', 'ex-cliente', 'parceiro'], ['novo', 'contactado', 'qualificado', 'ganho', 'perdido']],
  it: [['potenziale', 'cliente', 'ex cliente', 'partner'], ['nuovo', 'contattato', 'qualificato', 'vinto', 'perso']],
};
export const stageValues = (r, lang, n) => sample(r, pick(r, STAGE_WORDS[lang] ?? STAGE_WORDS.en), n);
export const BOOL_STYLES = { yn: ['Yes', 'No'], tf: ['true', 'false'], bin: ['1', '0'], sn: ['Sí', 'No'], ja: ['Ja', 'Nein'], oui: ['oui', 'non'], x: ['X', ''] };

/**
 * Values for one canonical field. `dirty` names how they are written: 'case' (upper-case mixed emails), 'pad'
 * (padded with blanks), 'phones' (mixed phone layouts), 'dates' (several unambiguous date layouts), 'dateFmt:<FORMAT>'
 * (one layout), 'numbers:<sep>' (thousands + decimals with the named decimal separator), 'bool:<style>'. Returns
 * { values, transform, params } where transform is what the data calls for (undefined: nothing in particular).
 */
export function valuesFor(r, canonical, rows, dirty = 'clean', lang = 'en') {
  const kind = kindOf(canonical);
  const v = [];
  let transform; let params;
  if (kind === 'EMAIL') {
    for (let i = 0; i < rows; i += 1) v.push(emailOf(r, i));
    if (dirty === 'case') { transform = 'NORMALISE_EMAIL_CASE'; v.forEach((x, i) => { if (i % 2 === 0) v[i] = x.replace(/^[^@]+/u, (m) => cap(m).toUpperCase()); }); }
    if (dirty === 'pad') { transform = 'TRIM_WHITESPACE'; v.forEach((x, i) => { v[i] = i % 2 === 0 ? ` ${x} ` : x; }); }
  } else if (dirty.startsWith('mostly:')) {
    // 'mostly:<style>': two values in three in the field's own clean form, the rest written as <style>: messy, but the column still
    // reads, by its dominant full-data shape, as what it is.
    const clean = valuesFor(r, canonical, rows, 'clean', lang).values;
    const messy = valuesFor(r, canonical, rows, dirty.slice(7), lang);
    clean.forEach((value, i) => v.push(i % 3 === 2 ? messy.values[i] : value));
    transform = messy.transform; params = messy.params;
  } else if (kind === 'PHONE') {
    // 'phonesLocal': national numbers without a country code, which only a declared region reads (D3-CAP-04).
    for (let i = 0; i < rows; i += 1) v.push(dirty === 'phonesLocal' ? `202-555-01${String(int(r, 10, 99))}` : phoneOf(r, dirty === 'phones' ? 'mixed' : 'e164'));
    if (dirty === 'phones' || dirty === 'phonesLocal') transform = 'PARSE_PHONE_E164';
  } else if (kind === 'DATE') {
    const formats = dirty === 'dates' ? sample(r, DATE_FORMATS, int(r, 2, 3)) : [dirty.startsWith('dateFmt:') ? dirty.slice(8) : 'ISO_8601'];
    for (let i = 0; i < rows; i += 1) v.push(dateIn(r, formats[i % formats.length]));
    if (dirty === 'dates' || (dirty.startsWith('dateFmt:') && dirty !== 'dateFmt:ISO_8601')) transform = 'PARSE_DATE_ISO';
  } else if (kind === 'NUMBER') {
    const sep = dirty.startsWith('numbers:') ? dirty.slice(8) : dirty.startsWith('decimal:') ? dirty.slice(8) : null;
    for (let i = 0; i < rows; i += 1) {
      const whole = int(r, 1200, 98000); const cents = int(r, 10, 99);
      // 'decimal:<sep>': a decimal separator and no grouping, so the shapes show the one separator alone.
      if (dirty.startsWith('decimal:')) { v.push(`${String(whole)}${sep}${String(cents)}`); continue; }
      const text = String(whole).replace(/\B(?=(\d{3})+(?!\d))/gu, sep === ',' ? '.' : ',');
      v.push(sep === null ? String(whole) : `${text}${sep}${String(cents)}`);
    }
    if (sep !== null) { transform = 'NORMALISE_NUMBER'; params = { decimalSeparator: sep }; }
  } else if (kind === 'BOOLEAN') {
    const style = dirty.startsWith('bool:') ? dirty.slice(5) : 'tf';
    const [yes, no] = BOOL_STYLES[style] ?? BOOL_STYLES.tf;
    for (let i = 0; i < rows; i += 1) v.push(i % 3 === 2 ? no : yes);
    if (style !== 'tf') transform = 'NORMALISE_BOOLEAN';
  } else if (kind === 'ENUM') {
    const n = Math.min(rows, 6);
    // 'safeEnum': words of the closed safe vocabulary a value map may carry, none of them an option of the vendor field (D3-CAP-05).
    const words = dirty === 'safeEnum' ? sample(r, Object.keys(SAFE_ENUM_MAP[canonical] ?? SAFE_ENUM_MAP['deal.stage']), int(r, 2, 4)) : canonical === 'lead.status' ? sample(r, ['Open', 'Working', 'Converted', 'Dead'], 3) : canonical === 'lead.leadSource' ? sample(r, ['web form', 'referral', 'trade show', 'partner', 'cold call'], 3) : canonical === 'lead.rating' ? ['hot', 'warm', 'cold'] : stageValues(r, lang, Math.max(2, Math.min(n, 4)));
    for (let i = 0; i < rows; i += 1) v.push(words[i % words.length]);
    transform = 'MAP_ENUM_VALUE';
  } else if (kind === 'URL') {
    for (let i = 0; i < rows; i += 1) v.push(canonical.endsWith('domain') ? domainOf(companyName(r)) : `https://www.${domainOf(companyName(r))}`);
  } else {
    const gen = /firstName/u.test(canonical) ? firstName : /lastName/u.test(canonical) ? lastName : /^deal\.name$/u.test(canonical) ? () => `${pick(r, ['Renewal', 'Expansion', 'Pilot', 'Onboarding', 'Supply contract'])} ${String(int(r, 2024, 2027))} ${cap(pick(r, SYL_A))}${pick(r, SYL_B)}` : /name$|company$/u.test(canonical) ? companyName : /city/u.test(canonical) ? () => pick(r, ['Valmora', 'Tessin', 'Orvale', 'Kelmar', 'Nuvia', 'Brandel', 'Quenby']) : /country/u.test(canonical) ? () => pick(r, ['Valdoria', 'Estmark', 'Norvania', 'Kelland']) : /postalCode/u.test(canonical) ? () => String(int(r, 10000, 99999)) : /jobTitle/u.test(canonical) ? () => pick(r, ['Account manager', 'Operations lead', 'Buyer', 'Site engineer', 'Controller']) : /industry/u.test(canonical) ? () => pick(r, ['Packaging', 'Logistics', 'Food service', 'Textiles', 'Software']) : /addressLine1/u.test(canonical) ? () => `${String(int(r, 1, 199))} ${cap(pick(r, SYL_A))}${pick(r, SYL_B)} Street` : /state/u.test(canonical) ? () => pick(r, ['North', 'Central', 'Coastal', 'Upland']) : () => pick(r, ['alpha', 'beta', 'gamma', 'delta']);
    for (let i = 0; i < rows; i += 1) v.push(gen(r));
    if (dirty === 'pad') { transform = 'TRIM_WHITESPACE'; v.forEach((x, i) => { v[i] = i % 2 === 0 ? `  ${x}` : `${x} `; }); }
  }
  if (lang === 'ja' || lang === 'zh') { /* names keep their Latin transliteration; scripts live in headers and notes */ }
  return { values: v, transform, params };
}

// ------------------------------------------------------------------ planted columns
const NOISE = [
  ['Internal ticket ref', 'IDENTIFIER', (r) => `TKT-${String(int(r, 1000, 9999))}`],
  ['Legacy system id', 'IDENTIFIER', (r) => `L${String(int(r, 10000, 99999))}`],
  ['Import batch', 'TEXT', (r) => `batch-${String(int(r, 1, 40))}`],
  ['Row checksum', 'IDENTIFIER', (r) => int(r, 0, 4294967295).toString(16)],
  ['Sales rep initials', 'TEXT', (r) => `${pick(r, 'ABCDEFGHJKLMNPRSTVW'.split(''))}${pick(r, 'ABCDEFGHJKLMNPRSTVW'.split(''))}`],
  ['Warehouse bin', 'IDENTIFIER', (r) => `${pick(r, ['A', 'B', 'C'])}-${String(int(r, 1, 99))}`],
  ['Colour tag', 'TEXT', (r) => pick(r, ['red', 'green', 'blue', 'amber'])],
  ['Folder code', 'IDENTIFIER', (r) => `F${String(int(r, 100, 999))}`],
  ['Audit remark code', 'IDENTIFIER', (r) => `R-${String(int(r, 1, 60))}`],
  ['Print run', 'NUMBER', (r) => String(int(r, 1, 9))],
];
export const NOISE_COUNT = NOISE.length;

// ------------------------------------------------------------------ the evidence a run can stand on
// The public contract a correct run is held to (B03 compiler, closed rationale vocabulary): a model maps a column only on a fact the
// request shows — the header names the target (its label, api name or canonical name: equal when written plainly, or sharing a word
// of three letters or more), the column's shapes read as the target's own type, its values are the target's options, or a verified
// convention of the agency's memory points the header at the target. A template that plants a MAP truth plants the fact that makes it
// reachable; where the header does not carry it, it plants the agency's convention (a verified CLIENT memory entry), which is how a
// real agency's repeat migrations name a column in another language. These helpers restate the contract over PLANTED facts; they never
// run IC.
const squeeze = (text) => text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/gu, '');
const asciiWords = (text) => text.normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length >= 3);
export const adapterHeaderOf = (mode, canonical) => getAdapter(mode).objects.flatMap((spec) => spec.fields).find((field) => field.canonicalField === canonical)?.header;
/** The names a target shows in a run: CLEAN_ONLY its canonical names; a vendor mode the planted label, the api name and the canonical name. */
export function targetNames(mode, canonical, label) {
  const name = canonical.split('.')[1] ?? canonical;
  if (mode === 'CLEAN_ONLY') return [name, canonical];
  const header = adapterHeaderOf(mode, canonical);
  const apiName = header === undefined ? name : (mode === 'HUBSPOT' ? name.toLowerCase() : header);
  return [label ?? header ?? name, apiName, name];
}
export const headerNames = (header, names) => squeeze(header) !== '' && names.some((name) => typeof name === 'string' && name !== '' && (squeeze(name) === squeeze(header) || asciiWords(name).some((word) => asciiWords(header).includes(word))));
// The types a full-data shape reads a value as (the data plane's shape names; leading-zero digits only an IDENTIFIER keeps whole).
const SHAPE_TYPE = Object.freeze({ emailLike: 'EMAIL', phoneInternational: 'PHONE', phoneLocalDigits: 'PHONE', isoDate: 'DATE', slashDateAmbiguous: 'DATE', booleanLike: 'BOOLEAN', integer: 'NUMBER', decimalPoint: 'NUMBER', decimalComma: 'NUMBER', groupedNumber: 'NUMBER', urlLike: 'URL' });
const VENDOR_TYPE = { HUBSPOT: { EMAIL: 'TEXT', PHONE: 'TEXT', DATE: 'DATE', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN' }, SALESFORCE: { EMAIL: 'EMAIL', PHONE: 'PHONE', DATE: 'DATE', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN' } };
/** The type a target holds in a run: CLEAN_ONLY by its canonical name; a vendor field by the type the planted contract gives it (an ENUM only with options). */
function targetType(mode, canonical, objects) {
  if (mode === 'CLEAN_ONLY') return canonical.endsWith('email') ? 'EMAIL' : canonical.endsWith('phone') ? 'PHONE' : canonical.endsWith('website') || canonical.endsWith('domain') ? 'URL' : 'TEXT';
  const [object, name] = canonical.split('.');
  const field = objects.find((entry) => entry.name === object)?.fields.find((entry) => entry.name === name);
  if (field === undefined) return 'TEXT';
  if ((field.options ?? []).length > 0) return 'ENUM';
  return VENDOR_TYPE[mode][field.valueClass] ?? 'TEXT';
}
const optionsOfTarget = (canonical, objects) => { const [object, name] = canonical.split('.'); return objects.find((entry) => entry.name === object)?.fields.find((entry) => entry.name === name)?.options ?? []; };
/** Whether a run has a fact to map this planted column to its destination on, short of memory: the header names it, a shape reads as its own non-text type, or every value is one of its options. */
function evidencedBy(mode, column, shapes, objects, labels, withoutHeader = false) {
  if (!withoutHeader && headerNames(column.header, targetNames(mode, column.destination, labels[column.destination]))) return true;
  const type = targetType(mode, column.destination, objects);
  if (type !== 'TEXT' && type !== 'ENUM' && shapes.some((shape) => SHAPE_TYPE[shape] === type)) return true;
  const options = optionsOfTarget(column.destination, objects);
  return options.length > 0 && column.values.filter((value) => value !== '').every((value) => options.includes(value));
}
/** The names the deterministic layer matches a header against exactly (B03 resolver: exact header match): a column whose header IS one of these is mapped without a model. */
function exactNames(mode, canonical, label) {
  const name = canonical.split('.')[1] ?? canonical;
  if (mode === 'CLEAN_ONLY') return [name, canonical, (CANONICAL_FIELDS[canonical]?.description ?? '').replace(/\.$/u, '')];
  const [, apiName] = targetNames(mode, canonical, label);
  return [label ?? adapterHeaderOf(mode, canonical) ?? name, apiName];
}
/**
 * The destination fields of `object` the deterministic layer maps this column to on its own: its header names them exactly, and its
 * dominant shape is compatible with their type (B03 resolver, first pass). CLEAN_ONLY offers every canonical field; a vendor mode the
 * planted contract's fields the data plane delivers.
 */
export function exactTargetsOf(mode, header, object, universeObjects, labels = {}, shapes = []) {
  const key = squeeze(header);
  if (key === '') return [];
  const fields = mode === 'CLEAN_ONLY' ? Object.keys(CANONICAL_FIELDS) : universeObjects.flatMap((entry) => entry.fields.map((field) => `${entry.name}.${field.name}`)).filter((canonical) => adapterHeaderOf(mode, canonical) !== undefined);
  const implied = SHAPE_TYPE[shapes[0]] ?? null;
  return fields.filter((canonical) => {
    if (canonical.split('.')[0] !== object || !exactNames(mode, canonical, labels[canonical]).some((name) => name !== '' && squeeze(name) === key)) return false;
    const type = targetType(mode, canonical, universeObjects);
    return implied === null || implied === type || type === 'TEXT' || (type === 'ENUM' && implied === null);
  });
}
// The primitives whose parameter must be evidenced (D3-CAP-04): the parameter, the destination types that need it, the shapes that ask.
const PARAMETERISED = Object.freeze({
  NORMALISE_NUMBER: { param: 'decimalSeparator', types: ['NUMBER'], shapes: ['decimalComma', 'groupedNumber'] },
  PARSE_DATE_ISO: { param: 'dateFormat', types: ['DATE', 'DATETIME'], shapes: ['slashDateAmbiguous'] },
  PARSE_PHONE_E164: { param: 'defaultRegion', types: ['PHONE'], shapes: ['phoneLocalDigits'] },
});
/** The value the evidence admits for a parameter: the separator the shapes show (one, not both), the declared date format the shapes are written in, the declared region. */
function evidencedParam(primitive, shapes, locale = {}) {
  if (primitive === 'NORMALISE_NUMBER') { const comma = shapes.includes('decimalComma'); const point = shapes.includes('decimalPoint'); return comma && !point ? ',' : point && !comma ? '.' : null; }
  if (primitive === 'PARSE_DATE_ISO') { const formats = new Set(shapes.flatMap((shape) => (shape === 'slashDateAmbiguous' ? ['DD/MM/YYYY', 'MM/DD/YYYY'] : shape === 'isoDate' ? ['ISO_8601'] : []))); return locale.dateFormat !== undefined && formats.has(locale.dateFormat) ? locale.dateFormat : null; }
  if (primitive === 'PARSE_PHONE_E164') return locale.defaultRegion ?? null;
  return null;
}
/** The primitives a column's own mapping may carry, by the type its dominant shape reads (B03 resolver): preservation and trimming always, the type's own normalisation. */
const PRIMITIVES_OF_TYPE = { EMAIL: ['NORMALISE_EMAIL_CASE'], PHONE: ['PARSE_PHONE_E164'], DATE: ['PARSE_DATE_ISO'], BOOLEAN: ['NORMALISE_BOOLEAN'], NUMBER: ['NORMALISE_NUMBER'] };
const PRIMITIVE_TYPES = { TRIM_WHITESPACE: ['TEXT', 'EMAIL', 'PHONE', 'URL', 'IDENTIFIER', 'ENUM'], NORMALISE_EMAIL_CASE: ['EMAIL'], PARSE_PHONE_E164: ['PHONE'], PARSE_DATE_ISO: ['DATE', 'DATETIME'], NORMALISE_BOOLEAN: ['BOOLEAN'], NORMALISE_NUMBER: ['NUMBER'], MAP_ENUM_VALUE: ['ENUM'] };
const TYPE_OF_SHAPE = Object.freeze({ ...SHAPE_TYPE, leadingZeroDigits: 'IDENTIFIER' });

/**
 * What of a MAP column's planted transform and semantic type a run can reach, and how (the public rules of B03: D3-CAP-03..05). A column
 * the deterministic layer maps carries no primitive unless a transformation question about it is answered (a parameterised primitive
 * its shapes ask for and the evidence admits a value of) or its values are put to a value map (an ENUM target with options, every value
 * a closed safe word); its type is its shapes' or its target's, or the one a type question chooses where the dominant shape reads it.
 * A column the model maps carries the primitive the model names among those its dominant shape admits. An expectation no run can meet
 * is not a property of the column but of the engine's reach: it is left out of the truth (`transform` any, `semanticType` any).
 */
function reachable(mode, column, shapes, objects, labels, locale, deterministic) {
  const type = targetType(mode, column.destination, objects);
  const implied = SHAPE_TYPE[shapes[0]] ?? null;
  const out = { ...column };
  const t = column.transform;
  if (typeof t === 'string') {
    let ok = false;
    if (deterministic) {
      const typeOpen = type !== 'ENUM' && new Set(shapes.map((shape) => SHAPE_TYPE[shape]).filter(Boolean)).size >= 2;
      const decided = type === 'ENUM' ? 'ENUM' : typeOpen ? type : (implied ?? type);
      const spec = PARAMETERISED[t];
      if (spec !== undefined && spec.types.includes(decided) && shapes.some((shape) => spec.shapes.includes(shape))) { const value = evidencedParam(t, shapes, locale); if (value !== null) { ok = true; out.params = { [spec.param]: value }; } }
      if (t === 'MAP_ENUM_VALUE' && type === 'ENUM') ok = true;
    } else {
      const allowed = ['PRESERVE_AS_IS', 'TRIM_WHITESPACE', ...(PRIMITIVES_OF_TYPE[implied] ?? [])];
      // A field the model maps in CLEAN_ONLY is typed TEXT (the compiler types a model's mapping only against a vendor contract).
      const semantic = mode === 'CLEAN_ONLY' ? 'TEXT' : type === 'ENUM' ? 'ENUM' : (implied ?? type);
      const spec = PARAMETERISED[t];
      const value = spec === undefined ? null : evidencedParam(t, shapes, locale);
      ok = allowed.includes(t) && (spec === undefined || value !== null) && (PRIMITIVE_TYPES[t] ?? []).includes(semantic);
      if (ok && spec !== undefined) out.params = { [spec.param]: value };
    }
    if (!ok) { delete out.transform; delete out.params; }
  }
  if (column.semanticType !== undefined) {
    let reached;
    if (deterministic) {
      const typeOpen = type !== 'ENUM' && new Set(shapes.map((shape) => SHAPE_TYPE[shape]).filter(Boolean)).size >= 2;
      reached = type === 'ENUM' ? 'ENUM' : typeOpen ? (TYPE_OF_SHAPE[shapes[0]] === column.semanticType || column.semanticType === type ? column.semanticType : type) : (implied ?? type);
    } else reached = mode === 'CLEAN_ONLY' ? 'TEXT' : type === 'ENUM' ? 'ENUM' : (implied ?? type);
    if (reached !== column.semanticType) delete out.semanticType;
  }
  return out;
}
/** A header the deterministic layer maps, exactly and alone, to `canonical` in this mode: the English header, the vendor's own, or a canonical name. */
export function exactHeaderFor(mode, canonical) {
  const [object, name] = canonical.split('.');
  const universe = [{ name: object, fields: [{ name, valueClass: classOf(canonical) }] }];
  const candidates = [headerOfField(canonical, 'en'), adapterHeaderOf(mode, canonical), name, (CANONICAL_FIELDS[canonical]?.description ?? '').replace(/\.$/u, '')].filter((entry) => typeof entry === 'string' && entry !== '');
  return candidates.find((header) => { const exact = exactTargetsOf(mode, header, object, universe); return exact.length === 1 && exact[0] === canonical; }) ?? candidates[0];
}
const hexOf = (r, n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');

/** A source builder: add planted columns, then take the planted facts. */
export function builder(r, { mode, family, capability, rows = 4, lang = 'en' }) {
  const columns = []; const headers = new Set();
  const unique = (header) => { let h = header; let n = 2; while (headers.has(h.toLowerCase())) { h = `${header} ${String(n)}`; n += 1; } headers.add(h.toLowerCase()); return h; };
  const base = (header, valueClass, values, extra) => { const h = unique(header); const column = { header: h, fieldRef: `src:${h}`, valueClass, values, ...extra }; columns.push(column); return column; };
  return {
    columns, rows, lang, mode,
    /** A source column the template maps to `canonical`. */
    // The primitive the planted values call for becomes part of the truth only where the template asks for it (`expect`): a column
    // mapped on an exact header takes no primitive unless a transformation question about it is answered, and a template states the
    // primitive only where its planted facts make that question (or the model's own mapping) reachable.
    // `exact`: the column carries a header the deterministic layer maps on its own (a clear column beside the one a fixture is about).
    map(canonical, { dirty = 'clean', header: given_header, exact = false, lang: l = lang, alternatives, evidence, semantic, transform, params, valueClass, values: given, n, expect = false, convention } = {}) {
      const header = exact ? exactHeaderFor(mode, canonical) : given_header;
      const made = valuesFor(r, canonical, n ?? rows, dirty, l);
      const t = transform !== undefined ? transform : expect ? made.transform : undefined;
      const p = params !== undefined ? params : expect ? made.params : undefined;
      return base(header ?? headerOfField(canonical, l), valueClass ?? classOf(canonical), given ?? made.values, {
        decision: 'MAP', destination: canonical,
        ...(alternatives === undefined ? {} : { alternatives }), ...(t === undefined ? {} : { transform: t }), ...(p === undefined ? {} : { params: p }),
        ...(semantic === undefined ? {} : { semanticType: semantic === true ? semanticOf(canonical) : semantic }), ...(evidence === undefined ? {} : { evidence }),
        ...(convention === false ? { convention: false } : {}),
      });
    },
    /** A column the template keeps untouched: a decoy no field of the target takes. */
    noise(k = 1) { for (const [header, cls, gen] of sample(r, NOISE, k)) base(header, cls, Array.from({ length: rows }, () => gen(r)), { decision: 'PRESERVE' }); },
    /** A free-form column of any decision with values supplied. */
    raw(header, valueClass, values, decision, extra = {}) { return base(header, valueClass, values, { decision, ...extra }); },
    /**
     * The planted facts. One file holds one object (the record mapping Migration Core runs it as): every MAP destination belongs to
     * `object` — the file's object, which the project declares, or `null` when the object is the question (CAP01). The run's class
     * follows from the decisions the truth plants, by the public contract: a run that maps a column drafts (PROPOSED), a run that
     * maps nothing and puts a decision to the agency awaits it (REQUIRES_AGENCY_DECISION), anything else abstains.
     */
    planted({ gates = noGates, tags, forbidden = [], taskTypes, alternativeOutcomes, memory, extra = 0, moreObjects = [], labels = {}, options, custom, universe: usedExtra = [], object, required = [], locale, recordIdColumn, conventions = true }) {
      // A line with no value in any column is no record: it is not planted (the data plane counts it, a run reads none of it).
      const height = Math.max(...columns.map((c) => c.values.length));
      const live = Array.from({ length: height }, (_, row) => columns.some((c) => (c.values[row] ?? '') !== ''));
      if (live.some((keep) => !keep)) for (const c of columns) c.values = Array.from({ length: height }, (_, row) => c.values[row] ?? '').filter((_, row) => live[row]);
      const mapped = columns.filter((c) => c.decision === 'MAP');
      const mapObjects = [...new Set(mapped.map((c) => c.destination.split('.')[0]))];
      if (mapObjects.length > 1) throw new Error(`${capability}/${mode}: one file holds one object, the MAP destinations span ${mapObjects.join(', ')}`);
      const fileObject = object === null ? null : (object ?? mapObjects[0]);
      if (fileObject === undefined) throw new Error(`${capability}/${mode}: no MAP column names the file's object; pass object`);
      if (fileObject !== null && mapObjects.length === 1 && mapObjects[0] !== fileObject) throw new Error(`${capability}/${mode}: the file holds ${fileObject}, a MAP destination is of ${mapObjects[0]}`);
      const used = [...new Set([...mapped.flatMap((c) => [c.destination, ...(c.alternatives ?? [])]), ...usedExtra.filter((c) => c !== undefined)])];
      // The first column stays a plain header (the profile read configuration names column 0).
      const plain = (c) => /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(c.header) && c.header === c.header.trim();
      const lead = columns.find(plain);
      const first = lead === undefined ? columns : [lead, ...columns.filter((c) => c !== lead)];
      const objects = universeOf(r, mode, used, { extra, moreObjects: [...moreObjects, ...(fileObject === null ? [] : [fileObject])], labels, options, custom, supplied: new Set([...mapped.map((c) => c.destination), ...required]) });
      // The full-data shapes of every column, read by the frozen data plane: what a truth about types may stand on.
      const shapes = shapesOf(first, mode);
      const shapeOf = new Map(first.map((c, i) => [c, shapes[i] ?? []]));
      // The deterministic layer claims a target once, in column order: the first column that names it exactly (and fits its type) takes it.
      const claimsOf = () => {
        const claims = new Map();
        if (fileObject !== null) for (const c of first) if (c.values.some((value) => value !== '')) {
          // Only an exact match to one target decides (a header naming two is a question).
          const exact = exactTargetsOf(mode, c.header, fileObject, objects, labels, shapeOf.get(c));
          if (exact.length === 1 && !claims.has(exact[0])) claims.set(exact[0], c);
        }
        return claims;
      };
      let claimed = claimsOf();
      // A supported fixture asks the model for at least one decision: when every column it maps is decided by its exact header, one
      // of them (never column 0, which the profile reads as the record id) carries its export suffix, as real exports do, and goes to the model.
      if (family === 'SUPPORTED' && mapped.length > 0 && mapped.every((c) => claimed.get(c.destination) === c)) {
        const plainMap = (c) => c.decision === 'MAP' && c.transform === undefined && c.semanticType === undefined && c.evidence === undefined;
        const moved = [...first].reverse().find((c) => plainMap(c) && c !== first[0]) ?? first.find(plainMap) ?? [...first].reverse().find((c) => c.decision === 'MAP');
        moved.header = `${moved.header} - src`;
        moved.fieldRef = `src:${moved.header}`;
        claimed = claimsOf();
      }
      // A column the truth does not map must not be one the deterministic layer maps on its own: that truth would contradict the
      // product's exact-match rule, and no candidate could satisfy it.
      for (const [target, c] of claimed) if (c.decision !== 'MAP' && !forbidden.includes(target)) throw new Error(`${capability}/${mode}: ${c.decision} column "${c.header}" is mapped on its exact header to ${target}`);
      // A column the model must map has to be offered its target: the run offers a column the writable targets of its object whose type
      // its dominant shape is compatible with (B03 resolver, plausible targets). A draw whose truth the run could not even be asked for
      // is not a fixture: it is drawn again (UNREACHABLE_DRAW).
      for (const c of first) if (c.decision === 'MAP' && fileObject !== null && claimed.get(c.destination) !== c) {
        const implied = SHAPE_TYPE[shapeOf.get(c)[0]] ?? null;
        const type = targetType(mode, c.destination, objects);
        if (!(implied === null || implied === type || type === 'TEXT')) throw Object.assign(new Error(`${capability}/${mode}: "${c.header}" reads as ${implied}, its target ${c.destination} holds ${type}`), { retry: true });
      }
      const ordered = first.map((c) => { const { convention, ...column } = c; void convention; return column.decision === 'MAP' ? reachable(mode, column, shapeOf.get(c), objects, labels, locale, claimed.get(c.destination) === c) : column; });
      // The agency's verified convention for a MAP column whose header and shapes give the model no fact to map it on (see above).
      const planted = [...(memory ?? [])];
      // The header a run sees may be masked by the privacy layer, so a convention is planted for every column the model must map whose
      // shapes or options alone do not carry it (a template may withhold one: `convention: false`).
      if (conventions !== false) first.forEach((source, i) => { const c = ordered[i]; if (c.decision === 'MAP' && source.convention !== false && claimed.get(c.destination) !== source && (conventions === 'all' || !evidencedBy(mode, c, shapeOf.get(source), objects, labels, true))) planted.push({ memoryId: `memconv_${hexOf(r, 12)}`, scope: 'CLIENT', owner: 'SAME_CLIENT', state: 'ACTIVE', sourceHeaderPattern: c.header.replace(/[\u200b-\u200f\ufeff]/gu, '').trim(), targetField: c.destination }); });
      const decisions = new Set(columns.map((c) => c.decision));
      const outcomeClass = decisions.has('MAP') ? 'PROPOSED' : decisions.has('AGENCY_DECISION') ? 'REQUIRES_AGENCY_DECISION' : 'ABSTAINED';
      const alternatives = decisions.has('MAP') ? [] : [...new Set(alternativeOutcomes ?? [])].filter((entry) => entry !== outcomeClass && entry !== 'PROPOSED' && entry !== 'REFUSED');
      const project = { object: fileObject === null ? null : fileObject.toUpperCase(), ...(locale === undefined ? {} : { locale }), ...(recordIdColumn === undefined ? {} : { recordIdColumn }) };
      return {
        family, mode, capability, outcomeClass, project, objects, columns: ordered, forbiddenDestinations: forbidden, gates,
        ...(taskTypes === undefined ? {} : { taskTypes }), ...(alternatives.length === 0 ? {} : { alternativeOutcomes: alternatives }), ...(tags === undefined ? {} : { tags }), ...(planted.length === 0 ? {} : { memory: planted }),
      };
    },
  };
}

export const TASK_OF = Object.freeze({ CAP01: 'OBJECT_MAPPING', CAP02: 'FIELD_MAPPING', CAP03: 'SEMANTIC_TYPE', CAP04: 'TRANSFORMATION_SELECTION', CAP05: 'VALUE_MAP', CAP06: 'IDENTITY_STRATEGY', CAP07: 'DUPLICATE_SIGNAL_STRATEGY', CAP08: 'ASSOCIATION_MAPPING', CAP09: 'UNMAPPED_HANDLING', CAP10: 'TARGET_REQUIREMENT', CAP11: 'CONSISTENCY_REVIEW', CAP12: 'SEMANTIC_REPAIR' });
export const CAPS = Object.freeze(Object.keys(TASK_OF));
