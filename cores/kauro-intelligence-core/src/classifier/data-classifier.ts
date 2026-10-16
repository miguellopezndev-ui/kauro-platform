/**
 * The Data Classifier, canon §17–§19: every value that could leave the data
 * plane gets a class before it may, and UNKNOWN fails closed. Headers,
 * labels, target text, memory text and repair codes go through the same
 * rules — provenance is not safety: a header can be an email address, a
 * memory pattern a person's name — plus a positive allow-list of what
 * structural metadata may look like. Low cardinality, short length and a
 * single word prove nothing: a short list of names is still PII, so a value
 * is safe semantics only by a closed vocabulary or the target's own options.
 */
import type { DataClass } from '../contracts/envelope.js';
import { IDENTIFIER_PATTERN, SUSPICIOUS_UNICODE } from '../contracts/schema.js';
import { INSTRUCTION_LIKE } from '../memory/memory-resolver.js';

export interface Classification {
  readonly dataClass: DataClass;
  readonly reason: string;
  readonly instructionLike: boolean;
}

/**
 * Which channel a piece of metadata text came through. Labels — source
 * headers, memory patterns, target labels — must look structural to pass.
 * Options are the enumerations of the attested TargetContract, and must be
 * provably enumeration tokens — closed vocabulary, codes, vocabulary words —
 * before they pass: the contract vouches for a list, never for a person in
 * it. Identifiers — api names, object names, types, file ids, validation
 * codes — must be identifiers.
 */
export type MetadataKind = 'LABEL' | 'OPTION' | 'IDENTIFIER';

const SECRET_SHAPES: readonly RegExp[] = [
  /\bpat-(?:na|eu)[0-9]?-[0-9a-f]{8}-/iu,
  /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{20,}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/iu,
];
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/u;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/u;
const CARD = /\b(?:\d[ -]?){13,19}\b/u;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/u;
const NATIONAL_ID = /\b\d{6,12}-?[A-Za-z0-9]\b/u;
/** A street word followed by a number, or a number followed by a street word: an address, wherever it appears. */
const ADDRESS_TEXT = /(?:\b(?:calle|c\/|avda\.?|avenida|carrer|rua|rue|street|road|avenue|straße|strasse|plaza|paseo|camino|travesía|travesia)\b[^\n]{0,40}\d)|(?:\b\d{1,5}\s+[\p{L}.'’-]+(?:\s+[\p{L}.'’-]+){0,3}\s+(?:street|st\.?|ave\.?|avenue|road|rd\.?|blvd\.?|boulevard|lane|ln\.?|drive|dr\.?|way)\b)/iu;
const NAME_HEADER = /(first|last|full|given|family|sur)?\s*name|nombre|apellido|contact|owner|persona/iu;
/** A header whose "name" is the name of an object or a label — StageName, Account Name, Company Name, Product Name — read with its camel-case words apart. */
const OBJECT_NAME_HEADER = /(?:^|[^\p{L}])(?:stage|account|company|product|deal|pipeline|campaign|organi[sz]ation|opportunity|project|brand|industry|file|sheet|object|api|label)[\s_.-]*names?(?![\p{L}])/iu;
/** Any word of a header that says a person is named however the object word reads: a header with one stays protected (Account Owner Name, Company Contact Name). */
const PERSON_QUALIFIER = /first|last|full|given|family|sur|nombre|apellido|contact|owner|persona|person|user|employee|manager|customer|client|lead|author|rep\b/iu;
/**
 * Whether a header names people (D3-PRIV: the privacy layer stays
 * conservative). "name" alone, or with a person word, protects the column; it
 * stops only where an object or label word qualifies the name and no person
 * word is in the header.
 */
function headerNamesPerson(header: string): boolean {
  if (!NAME_HEADER.test(header)) return false;
  const words = header.normalize('NFKC').replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, '$1 $2');
  return !(OBJECT_NAME_HEADER.test(words) && !PERSON_QUALIFIER.test(words));
}
const ADDRESS_HEADER = /address|street|direcci|calle|postal|zip/iu;
const SENSITIVE_HEADER = /health|salud|religion|ethnic|racial|political|sexual|biometric|genetic|salary|salario|ssn|dni|nif|passport|pasaporte|tax|iban|card|tarjeta|credit|payment/iu;
/** The closed vocabulary of safe semantics: booleans, statuses, stages, priorities, ISO-style codes, small integers. Nothing else is safe by shape. */
const SAFE_VOCABULARY = /^(true|false|yes|no|si|sí|y|n|oui|non|ja|nein|sim|não|nao|on|off|active|inactive|activo|activa|inactivo|inactiva|ativo|inativo|actif|inactif|aktiv|inaktiv|enabled|disabled|open|closed|abierto|abierta|cerrado|cerrada|aberto|fechado|ouvert|fermé|offen|geschlossen|won|lost|ganado|ganada|perdido|perdida|ganho|gagné|perdu|gewonnen|verloren|new|nuevo|nueva|novo|nova|nouveau|neu|pending|pendiente|pendente|en attente|done|hecho|feito|completed|complete|completado|completa|concluído|terminé|erledigt|in progress|en curso|em andamento|en cours|cancelled|canceled|cancelado|cancelada|annulé|storniert|on hold|paused|pausado|archived|archivado|draft|borrador|high|medium|low|alta|alto|media|medio|baja|bajo|haute|moyenne|basse|hoch|mittel|niedrig|urgent|urgente|critical|crítico|normal|lead|mql|sql|opportunity|oportunidad|customer|cliente|subscriber|suscriptor|evangelist|prospect|prospecto|qualified|unqualified|calificado|hot|warm|cold|male|female|other|otro|otra|outro|autre|andere|n\/a|na|none|ninguno|ninguna|null|unknown|desconocido|empty|tbd|ok|ko|\d{1,3})$/iu;
/** The shape of an ISO code: two or three capitals. The shape alone proves nothing — LEE, WU, LIM and HO have it too — so a token with it is a code only when the closed lists below know it, and otherwise UNKNOWN (R2R-PC-01). A lower-case three-letter word is a word, and a word proves nothing. */
const ISO_SHAPE = /^[A-Z]{2,3}$/u;
/**
 * The closed lists an upper-case two- or three-letter token may be a code
 * by: ISO 3166-1 alpha-2 and alpha-3 country codes (the 249 assigned, plus
 * UK and EU, exceptionally reserved and written in every CRM) and ISO 4217
 * currency codes (the active list, the X funds and metals included). Not
 * ISO 639: language picklists in CRMs are written as locales (es-ES), and a
 * two-letter language code is a two-letter surname as often as not. A
 * given name that is also a code — BEN, MAR — is a name first: the name
 * list is read before the code list in every channel.
 */
const ISO_CODES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW UK EU
  AND ARE AFG ATG AIA ALB ARM AGO ATA ARG ASM AUT AUS ABW ALA AZE BIH BRB BGD BEL BFA BGR BHR BDI BEN BLM BMU BRN BOL BES BRA BHS BTN BVT BWA BLR BLZ CAN CCK COD CAF COG CHE CIV COK CHL CMR CHN COL CRI CUB CPV CUW CXR CYP CZE DEU DJI DNK DMA DOM DZA ECU EST EGY ESH ERI ESP ETH FIN FJI FLK FSM FRO FRA GAB GBR GRD GEO GUF GGY GHA GIB GRL GMB GIN GLP GNQ GRC SGS GTM GUM GNB GUY HKG HMD HND HRV HTI HUN IDN IRL ISR IMN IND IOT IRQ IRN ISL ITA JEY JAM JOR JPN KEN KGZ KHM KIR COM KNA PRK KOR KWT CYM KAZ LAO LBN LCA LIE LKA LBR LSO LTU LUX LVA LBY MAR MCO MDA MNE MAF MDG MHL MKD MLI MMR MNG MAC MNP MTQ MRT MSR MLT MUS MDV MWI MEX MYS MOZ NAM NCL NER NFK NGA NIC NLD NOR NPL NRU NIU NZL OMN PAN PER PYF PNG PHL PAK POL SPM PCN PRI PSE PRT PLW PRY QAT REU ROU SRB RUS RWA SAU SLB SYC SDN SWE SGP SHN SVN SJM SVK SLE SMR SEN SOM SUR SSD STP SLV SXM SYR SWZ TCA TCD ATF TGO THA TJK TKL TLS TKM TUN TON TUR TTO TUV TWN TZA UKR UGA UMI USA URY UZB VAT VCT VEN VGB VIR VNM VUT WLF WSM YEM MYT ZAF ZMB ZWE
  AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWL ZWG`
    .split(/\s+/u)
    .filter((code) => code !== ''),
);
/** An ISO code is a token the closed lists know, never a token that merely looks like one. */
const isoCode = (token: string): boolean => ISO_SHAPE.test(token) && ISO_CODES.has(token);
/**
 * An ISO 3166-1 alpha-2 country code the closed list knows (the assigned
 * codes, UK and EU): the only region a project may declare for its phone
 * numbers (D3-CAP-04). Two capitals the list does not know — WU, LI, HO —
 * are a surname as often as a code, and never a region.
 */
export const countryCode = (token: string): boolean => /^[A-Z]{2}$/u.test(token) && ISO_CODES.has(token);
/**
 * The eligibility of a token that carries a digit (data policy 1.5.1,
 * R-IC-PRIVACY 009). Such a token is a compact code or a personal handle,
 * and nothing about its case, its length, the number of its digits against
 * its letters, its separators or its presence in an attested option list
 * tells which: HENDERSON7 has the shape of SKU-0042, NDE-8 the shape of
 * PO-8, wu2024 the shape of q1. Only what the letter runs *are* tells. The
 * precedence, read in this order on the whole token:
 *
 *   1. the narrow structural-identifier grammar Migration Core mints file
 *      ids in, `F-` and twelve hex digits (F-1a5dfa29636d): a code whatever
 *      its hex letters spell, and the only grammar admitted whole;
 *   2. every letter run of the token is known — a single Latin letter
 *      (A12, a12, 4b, B2B, Q1, 2024Q1, S0), a closed compact prefix in the
 *      first position (SKU-0042, ISO-9001, PO_2024/07), or a word of the
 *      label, enumeration or safe vocabulary, plurals and camel compounds
 *      included (tier1, phone2, level3, Tier2, nivel1, Address2, ClosedWon2)
 *      — then the token is a code;
 *   3. otherwise the token is a handle — HENDERSON7, jkowalski1, mlopez01,
 *      NDE-8, wu2024, ndebelehenderson1234, 田中7, ÑÁÑEZ7 — and a handle is
 *      POTENTIAL_PII on every channel: it never stays UNKNOWN to avoid the
 *      call, and no option list, label or contract vouches for it.
 *
 * What is not on the list is not a rule: a digit-to-letter ratio is not,
 * capitals are not, a change of case inside a run is not (nG1, wU99 and
 * yN1 are handles, not the symbols n, G, w, U, y and N), two-to-three
 * capitals before a separator are not, length is not (a handle of ninety
 * letters is a handle, never free text), and a bare ISO 3166/4217 code (US,
 * DE, EUR) followed by digits is not — the code lists admit the bare code
 * and nothing beside it. The name lists are read over the letter runs before
 * any of this (letterRuns), so zuleika7 is the name it carries, not merely a
 * handle.
 */
const MIGRATION_CORE_FILE_ID = /^F-[0-9a-f]{12}$/u;
/**
 * The closed compact prefixes: the abbreviations business documents, product
 * codes and standards are numbered by — a semantic list, deliberately
 * mundane, never a shape. An entry earns its place by naming what the number
 * after it counts (a purchase order, a stock-keeping unit, an ISO standard);
 * a two- or three-letter run that merely looks like one of these (NDE, HEN,
 * KOW, LEE) is not one, and being followed by digits is not a reason. Read
 * case-insensitively, as the vocabulary words are; the list itself is what
 * authorises, never the capitals. Personal-identifier prefixes (DNI, NIF,
 * SSN, VAT, IBAN) are deliberately absent: those numbers are the person's.
 */
const COMPACT_PREFIXES = new Set('sku po so inv ord doc ref rfq rma qt lot sn pn tkt case prj opp ver rev iso iec din ansi astm une ieee rfc gtin ean upc isbn duns naics cpv'.split(' '));
/** One separator at most between a compact prefix and its number: SKU-0042, PO_2024/07, ISO9001. */
const COMPACT_SEPARATOR = /^[_./:-]/u;
/** What a compact token is written with: letters of any script with their marks, digits, and the separators `_ - . / :` — at any length. A length cap here would let a long handle slip past the rule into the length-based FREE_TEXT of the channels (revision 009 review, PRIVACY-009-LENGTH-BYPASS), so there is none: a handle is a handle at 4 characters and at 400. */
const COMPACT_TOKEN = /^[\p{L}\p{M}\p{Nd}_./:-]+$/u;
const LATIN_LETTER = /^[A-Za-z]$/u;
export type CompactVerdict = 'CODE' | 'HANDLE';

/** Accents and case do not distinguish words here; a lookup key is the folded word. */
const fold = (word: string): string => word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Words a header, a label or a memory pattern may be made of: what CRM and
 * spreadsheet metadata is written with in es/en/pt/fr/de. A token outside
 * this list, the stop words and the identifier shapes is not provably
 * structural. The list is a positive allow-list, deliberately mundane.
 */
const LABEL_WORDS = new Set(
  `id ids identifier identificador identificateur kennung uuid guid key clave chave clé schlüssel ref reference referencia referência référence referenz code codigo código kode number numero número numéro nummer num no nr seq sequence index
  name nombre nome nom firstname lastname first last middle given family sur surname apellido apellidos sobrenome prénom prenom vorname nachname title titulo título titre titel salutation saludo tratamiento anrede prefix suffix initials iniciales nickname alias display full completo complet
  email e-mail mail correo courriel electronico electrónico eletrônico secondary secundario primary primario principal alternate alternativo
  phone telephone teléfono telefono telefone téléphone telefon mobile movil móvil celular cellulaire handy fax whatsapp ext extension
  address direccion dirección endereço adresse street calle rua rue strasse straße city ciudad cidade ville stadt state estado provincia province région region regiao região land county country pais país pays zip cp postal postcode plz codigo postal locality localidad
  company empresa companhia entreprise firma unternehmen organisation organization organizacion organización account cuenta conta compte konto industry industria sector secteur branche segment segmento vertical size tamaño tamanho taille größe employees empleados funcionários employés mitarbeiter revenue ingresos receita chiffre umsatz annual anual annuel
  website web site sitio url domain dominio domínio domaine linkedin twitter facebook instagram social
  status estado estatus situação statut lifecycle stage etapa fase phase stufe pipeline funnel embudo priority prioridad prioridade priorité priorität score puntuacion puntuación pontuação rating grade nivel nível level tier rank
  owner propietario proprietário propriétaire besitzer assigned asignado assignee responsable responsável verantwortlich rep representative representante manager gerente team equipo equipe équipe user usuario usuário utilisateur benutzer agent agente creator creador created creado criado créé erstellt modified modificado modifié geändert updated actualizado atualizado mis à jour aktualisiert
  date fecha data datum time hora heure zeit timestamp datetime day dia día jour tag month mes mês mois monat year año ano année jahr week semana semaine woche quarter trimestre start inicio início début beginn end fin fim ende close cierre closing deadline vencimiento due birth nacimiento nascimento naissance geburt birthday cumpleaños aniversário last first next último proximo próximo dernier prochain letzter nächster activity actividad atividade activité aktivität contacted contactado login visit visita
  source origen origem origine quelle campaign campaña campanha campagne kampagne medium channel canal kanal utm term content contenido conteúdo contenu inhalt referrer referral
  type tipo type typ category categoria categoría catégorie kategorie class clase classe klasse kind group grupo groupe gruppe tag tags etiqueta etiquetas label labels rotulo rótulo étiquette flag flags
  amount importe monto montante montant betrag value valor valeur wert price precio preço prix preis cost coste custo coût kosten total subtotal sum suma soma summe qty quantity cantidad quantidade quantité menge currency moneda moeda devise währung discount descuento desconto remise rabatt budget presupuesto orçamento
  deal negocio negócio affaire opportunity oportunidad oportunidade opportunité chance contract contrato contrat vertrag order pedido encomenda commande bestellung invoice factura fatura facture rechnung quote cotizacion cotización orçamento devis angebot product producto produto produit produkt plan service servicio serviço subscription suscripcion suscripción assinatura abonnement
  notes note notas nota anotações remarks comentario comentarios comentário commentaire kommentar description descripcion descripción descrição beschreibung details detalle detalles détails summary resumen resumo résumé message mensaje mensagem reason motivo razon razón raison grund
  contact contacto contato lead prospect prospecto client cliente customer person persona pessoa personne member miembro membro membre mitglied partner socio sócio vendor proveedor fornecedor fournisseur lieferant supplier
  internal interno interna externo external custom personalizado legacy old new nuevo nueva novo nova antiguo original previous anterior current actual atual actuel aktuell main mayor menor min max avg average media promedio count conteo total number ultimo ultima primer primero primera segundo segunda creation creacion criacao erstellung
  salary salario sueldo wage health salud tax taxes impuesto impuestos iva vat nif dni cif nie passport pasaporte iban bic swift bank banco card tarjeta credit credito debit payment pago pagamento paiement zahlung gender genero sexo sex nationality nacionalidad condition condicion
  yes no si sí flag boolean bool active activo activa inactive opt in out optin optout consent consentimiento consentement subscribed unsubscribed newsletter marketing sales ventas vendas comercial support soporte suporte service servicio bill billing facturacion facturación shipping envio envío entrega delivery
  language idioma lingua língua langue sprache locale timezone zona horaria country region format version versión versão schema field campo champ feld column columna coluna colonne spalte row fila linha ligne zeile sheet hoja folha feuille blatt file archivo arquivo fichier datei record registro registre datensatz object objeto objet objekt property propiedad propriedade propriété eigenschaft attribute atributo attribut
  unknown desconocido test prueba sample muestra demo example ejemplo exemplo exemple beispiel misc other otro otra outro autre sonstiges extra additional adicional info information información informação
  home casa hogar work trabajo trabalho travail arbeit job empleo emprego position posicion posición posição poste cargo puesto occupation ocupacion ocupación profession profesion profesión role rol función funcion department departamento departement abteilung division división unit unidad office oficina bureau büro business personal private privado publico público mailing postal physical fisico físico legal registered registrado headquarters hq branch sucursal filial location ubicacion ubicación place lugar seat sede fiscal residence residencia residential residencial second third fourth line linea línea suite floor piso apartment apartamento apto building edificio complement complemento
  method metodo método preferred preferido preferida preference preferencia associated asociado asociada became converted convertido qualified calificado cualificado disqualified username handle profile perfil ticker symbol simbolo símbolo sic naics ownership propiedad parent matriz child subsidiary subsidiaria hubspot salesforce zoho pipedrive dynamics import imported exported export batch lote lote sync synced synchronised sincronizado fuente system sistema call llamada llamar meeting reunion reunión email emails visits pageviews sessions sesiones conversion conversión conversions score scoring engagement lifecycle
  not do dont never nunca sin without mit ohne per por cada each every all todos todas any alguno ninguna none first primero
  zone zona zonas won ganado ganada lost perdido perdida alta baja ingreso egreso registration open abierto abierta closed cerrado cerrada pending pendiente done hecho completed completado high low medium alto bajo medio media ok ko true false verdadero falso enabled disabled habilitado deshabilitado verified verificado unverified
  crm erp nps mrr arr ltv cac kpi seo sem ppc cta faq sms sso api hr qa ux ui ceo cfo cto coo dob ssn ein cnpj cpf nit rut curp kvk abn acn gst hst tva btw mwst sku hs sf sfdc
  text string enum enumeration picklist multipicklist textarea checkbox lookup formula double integer int float decimal percent percentage reference richtext
  by is has are was were does did can opted bounced viewed referenced assistant photo clean master report reports`
    .split(/\s+/u)
    .filter((word) => word !== '')
    .map(fold),
);
const STOP_WORDS = new Set('a an the of de del la el los las da do das dos du des le les und y e and or o ou u pour para por en in on at to von der die das per con com avec mit im am zu au aux al na nos nas für sur bei vs'.split(' ').map(fold));

/**
 * Common given names across es/en/pt/fr/de — a compact list, not a census:
 * it catches the everyday case where a "segment" is a list of people, and
 * the proper-noun shape catches what the list does not. Words that are also
 * ordinary label vocabulary (Max, Will, May, Mark) are left out on purpose.
 */
const GIVEN_NAMES = new Set(
  `ada adam adrian adriana agnes agustin agustín aitor alan alba albert alberto alejandra alejandro alessandro alex alexander alexandra alfonso alfredo alice alicia alina alison allison alma alonso alvaro álvaro amanda amelia amparo amy ana anabel anais anaïs anders andre andré andrea andreas andres andrés andrew angel ángel angela ángela angelica angélica anita ann anna anne annie anthony antoine antonia antonio ariadna ariel arnau arthur arturo asier aurora axel
  barbara bárbara bastian beatriz beatrice ben benjamin benjamín bernard bernardo berta bianca blanca bob brandon brenda brian bruno
  camila camille candela carla carlos carlota carmen carol carolina caroline catalina catherine cecilia celia cesar césar charles charlotte chiara chloe chloé chris christian christina christine christoph christopher cindy clara claire claude claudia clemente concha consuelo cristian cristina cristóbal cristobal cynthia
  dalia damian damián dan dana daniel daniela daniele danny dario darío david debora déborah deborah denis dennis derek diana diego dolores dominic dominique dora doris dorothy douglas dylan
  edgar eduardo edward elena eleonora eli elias elías elisa elisabeth elizabeth ella ellen elsa elvira emil emilia emilio emily emma enrique eric erik erika ernesto esperanza esteban estela esther eugenia eugenio eva evelyn
  fabian fabián fabio fatima fátima federico felipe felix félix fernanda fernando fiona flavia florence florian francesca francesco francis francisca francisco frank franz fred frederic frédéric
  gabriel gabriela gael gaspar gema gemma george georgina gerard gerardo german germán gina gisela giulia giuseppe gloria gonzalo grace graciela greg gregorio greta guadalupe guillaume guillermo gustavo
  hannah hans harry heather hector héctor heidi helen helena henry hilda hugo
  ian ignacio ines inés ingrid inma inmaculada irene iris isaac isabel isabela isabella isabelle isidro ismael ivan iván ivana
  jack jacob jacqueline jaime james jan jane janet jared jasmine jason javier jean jeanne jeff jennifer jenny jeremy jerome jérôme jesica jessica jesus jesús jimena jimmy joan joana joanna joao joão joaquin joaquín joe joel johanna john jon jonas jonathan jordi jorge jose josé josefa josefina joseph josephine josh joshua josue josué juan juana judith julia julian julián julie julien julio justin
  karen karina karl katherine kathrin katia katrin kevin kim klaus kurt
  larissa lara laura laurent lea léa leah leandro leo leon león leonardo leonor leticia lidia liliana lina linda lisa liz lola lorena lorenzo louis louise luc luca lucas lucia lucía luciana lucy ludovic luis luisa luiz lukas luke
  magdalena manuel manuela mar marc marcel marcela marcelo marco marcos margarita margaret maria maría mariana marian marianne marie marina mario marion marisa marisol marta martha martin martín martina mateo mathieu matias matías matilde matteo matthew matthias maurice mauricio maximilian melanie mélanie melissa mercedes michael michel michele michelle miguel mikel milagros milena miriam mohamed monica mónica montse montserrat
  nadia nancy natalia natalie nathalie nathan nelson nerea nicolas nicolás nicole nikolaus nina noa noah noelia noemi noemí nora norberto nuria núria
  octavio olga oliver olivia olivier omar oriol oscar óscar oswaldo otto
  pablo paloma pamela paola paolo pascal patricia patrick paul paula paulina pauline pedro pepe peter petra philip philippe pierre pilar
  rafael rafaela ramiro ramon ramón raquel raul raúl rebeca rebecca renata rene rené ricardo richard rita robert roberta roberto rocio rocío rodrigo rogelio roger rolando roman román romina ronald rosa rosalia rosalía rosario rose ruben rubén rudolf ruth ryan
  sabine sabrina salvador samantha samuel sandra sandro santiago sara sarah sasha scott sebastian sebastián sergio sharon silvia simon simón simone sofia sofía sonia sophie soraya stefan stefano stephanie stéphanie stephen steve steven susan susana sven sylvia
  tamara tania tatiana teresa teodoro thomas tiago timothy tina tobias tom tomas tomás toni tony tristan
  ulrich ursula uwe
  valentin valentín valentina valeria valerie valérie vanessa vera veronica verónica vicente victor víctor victoria vincent violeta virginia vivian viviana
  walter wendy werner wilhelm william wolfgang
  xavier ximena yago yolanda yves yvonne zacarias zoe zoé
  svetlana natasha nadezhda ekaterina yekaterina katya irina ludmila lyudmila galina oksana anastasia darya dasha yulia polina ksenia kseniya zoya dmitri dmitry dimitri sergei sergey andrei andrey alexei alexey aleksey vladimir vladislav igor oleg boris nikolai nikolay mikhail pavel pyotr yuri yury anatoly anatoli stanislav vitaly vitali konstantin kirill ruslan timur
  agnieszka katarzyna małgorzata malgorzata zofia zuzanna jakub kacper mateusz wojciech krzysztof piotr paweł pawel tomasz łukasz lukasz marcin michał michal bartosz
  mohammed muhammad mohammad ahmed ahmad ali hassan hussein khalid khaled youssef yusuf ibrahim mustafa mostafa abdullah abdul aisha aicha layla leila zainab zaynab maryam mariam nour noor amira yasmin yasmine salma huda zuleika zulema mehmet ayşe ayse fatma emine hatice zeynep elif murat ahmet
  giovanni giorgio alessia federica giulio riccardo tommaso davide pietro jürgen juergen jörg joerg dieter helmut manfred günter gunter horst heike ute anke birgit kerstin silke lars nils bjorn björn olaf magnus gunnar kristian astrid sigrid freya solveig mathilde manon amélie amelie élodie elodie sébastien sebastien françois francois thierry didier gérard dimitris giorgos nikos yannis kostas eleni katerina
  rahul priya amit sanjay vikram deepak rajesh sunil anjali pooja neha kavita arjun ravi suresh ramesh anil hiroshi takeshi kenji yuki haruto sakura yui hana taro tarō hanako ichiro minsu jiho seojun jimin minji bruna vitor ashley megan lauren ethan liam mason logan aiden jayden harper avery madison abigail sophia mia zoey lily`
    .split(/\s+/u)
    .filter((word) => word !== '')
    .map(fold),
);

/**
 * The endings family names are built with where the list cannot reach —
 * Slavic, Romanian, Armenian, Turkish, Nordic, Iberian patronymics — on a
 * capitalised token that is not label vocabulary: Kowalski, Petrova,
 * Ivanov, Kovačević, Popescu, Andersson, Jensen, Fernández. A word of the
 * vocabulary or the safe vocabulary is a word whatever it ends in.
 */
const FAMILY_NAME_ENDING = /^\p{Lu}[\p{Ll}'’-]+(?:ski|ska|cki|cka|wicz|czyk|ov|ova|ev|eva|enko|escu|ić|vić|oğlu|oglu|sson|dóttir|dottir|[^aeiouáéíóú]sen|[^aeiouáéíóú]son|[^aeiouáéíóú]ez)$/u;

/**
 * The common family names of es/en/pt/fr/de — a compact list, not a census
 * — read for one purpose only (R2R-PC-03): to tell, when a single
 * capitalised word is at once enumeration vocabulary and a surname (Klein,
 * Petit, Gross, Grand, Price, Fields, Banks, Day, Gold, Silver, Campos,
 * Casas, Fuentes, Chance, Plata), that the word may be a person. The list
 * does not make a word a name on its own: Smith or García in an option
 * list are refused already as proper nouns or by ending, and a name that
 * is not vocabulary gains nothing from being here.
 */
const SURNAMES = new Set(
  `garcia rodriguez gonzalez fernandez lopez martinez sanchez perez gomez martin jimenez ruiz hernandez diaz moreno muñoz alvarez romero alonso gutierrez navarro torres dominguez vazquez ramos gil ramirez serrano blanco molina morales suarez ortega delgado castro ortiz rubio marin sanz iglesias medina garrido cortes castillo santos lozano guerrero cano prieto mendez cruz calvo gallego vidal leon herrera marquez peña flores cabrera campos vega fuentes carrasco diez caballero reyes nieto aguilar pascual herrero santana lorenzo montero hidalgo ibañez ferrer duran santiago benitez mora vicente vargas arias carmona crespo roman pastor soto velasco moya soler parra esteban bravo gallardo rojas casas plata grande
  smith johnson williams brown jones miller davis wilson anderson taylor thomas moore jackson white harris clark lewis robinson walker young allen king wright scott green baker adams nelson hill campbell mitchell roberts carter phillips evans turner parker collins edwards stewart morris murphy cook rogers morgan cooper peterson bailey reed kelly howard ward cox richardson wood watson brooks bennett gray james hughes price sanders myers long ross foster powell fields banks day gold silver small chance grant bell hunt fox stone bush marsh ford wells lane rice
  silva oliveira souza sousa lima pereira ferreira costa carvalho almeida nascimento araujo ribeiro barbosa gomes melo dias cardoso rocha correia teixeira moreira pinto freitas cunha machado monteiro nunes cavalcanti azevedo batista mendes
  bernard dubois robert richard petit durand leroy moreau simon laurent lefebvre michel david bertrand roux vincent fournier morel girard andre lefevre mercier dupont lambert bonnet francois legrand garnier faure rousseau blanc guerin muller henry roussel nicolas perrin morin mathieu clement gauthier dumont fontaine chevalier robin masson gerard boyer denis lemaire duval joly gautier roger roche roy noel meyer lucas meunier marchand dufour blanchard barbier brun dumas brunet schmitt leroux colin renard arnaud rolland caron aubert giraud leclerc bourgeois renaud lemoine picard gaillard leclercq lacroix fabre dupuis olivier hubert charles guillaume adam
  müller mueller schmidt schneider fischer weber wagner becker schulz hoffmann schäfer schaefer koch bauer richter klein wolf schröder schroeder neumann schwarz zimmermann braun krüger krueger hofmann hartmann lange werner schmitz krause meier lehmann schmid schulze maier köhler koehler herrmann könig koenig walter mayer huber kaiser fuchs peters lang scholz möller moeller weiß weiss jung hahn schubert vogel friedrich keller günther guenther frank berger winkler roth beck lorenz baumann franke albrecht schuster ludwig böhm boehm winter kraus schumacher krämer kraemer vogt stein jäger jaeger otto sommer groß gross seidel heinrich brandt haas schreiber graf schulte dietrich ziegler kuhn kühn pohl engel horn busch bergmann voigt sauer arnold wolff pfeiffer kurz lindner ernst hübner huebner kramer grand`
    .split(/\s+/u)
    .filter((word) => word !== '')
    .map(fold),
);

/**
 * A label that may name people beyond the person-field vocabulary below —
 * sellers, users, authors, approvers, members, contacts, staff, in the
 * languages of the label list and the scripts picklists come in. Read for
 * the homonym tie-break only (R2R-PC-03): under such a label a vocabulary
 * word that is also a surname is taken for the surname. It drops nothing
 * else and permits nothing: Retail under Segmento comercial still travels.
 */
const PERSON_LIKE_LABEL = /(?:\b(?:sales\s*reps?|reps?|comercial|commercial|vendedora?|vendeur|verkäufer|verkaeufer|seller|salesperson|account\s+executive|created\s+by|modified\s+by|updated\s+by|creado\s+por|modificado\s+por|autor|author|approver|aprobador|reviewer|revisor|recruiter|reclutador|referred\s+by|referido\s+por|employee|empleado|staff|users?|usuarios?|usuários?|utilisateurs?|benutzer|contacts?|contactos?|contatos?|persons?|personas?|pessoas?|personnes?|members?|miembros?|membros?|membres?|mitglied|colaborador|collaborator|mitarbeiter)\b)|менеджер|владелец|ответственн|продавец|担当|负责|所有者|소유자|담당자/iu;

/**
 * Words picklists are made of beyond the label vocabulary: the default stage
 * and status vocabularies CRMs ship with (HubSpot lifecycle stages and lead
 * statuses, Salesforce lead and opportunity stages, Pipedrive and Zoho
 * pipelines), company sizes and tiers, plans, cadences, channels and the
 * industries a segment picklist names, in es/en/pt/fr/de. Added in round 3
 * (R2-PC-01) because the OPTION channel no longer takes a capitalised word
 * on the contract's word alone: an option must be provably an enumeration,
 * so the enumerations CRMs ship with have to be spelled out. Deliberately
 * mundane: a word that is also a common given name (Max, Will, May, Mark,
 * Rose, Iris, Aurora, Sol) is left out, and no entry is a person's name in
 * any language. A country picklist travels as ISO codes, not as names.
 */
const ENUMERATION_WORDS = new Set(
  `enterprise startup smb sme pyme vip apac emea latam noram midmarket mid market corporate corporativo corporativa individual particular autonomo autónomo freelance freelancer agency agencia agência agence agentur small pequeño pequeña pequeno pequena petit petite klein medium mediano mediana médio média moyen moyenne mittel large grande grand groß gross big micro macro unassigned asignar zugewiesen attribué
  prospecting prospección prospeccion prospecção qualification cualificación cualificacion qualificação needs analysis análisis analisis análise analyse proposition proposal propuesta proposta negotiation negociación negociacion negociação négociation verhandlung review revisión revision revisão révision decision decisión decisao decisão makers perception evaluation evaluación evaluacion avaliação évaluation discovery descubrimiento scheduled programado programada agendado agendada made started iniciado iniciada attempted intentado future futuro junk spam pre working trabajando progress progreso progresso andamento nurturing nurture recycled reciclado engaged interested interesado interesada churned churn renewal renovación renovacion renewed onboarding onboarded trial upsell expansion expansión downgrade upgrade won lost
  free gratis gratuit kostenlos basic básico basico basique standard estándar estandar padrão premium pro professional profesional profissional professionnel starter growth scale plus lite advanced avanzado avançado avancé gold silver bronze platinum diamond oro plata bronce platino diamante ouro prata argent
  monthly mensual mensal mensuel monatlich yearly annually jährlich quarterly trimestral weekly semanal hebdomadaire wöchentlich daily diario diaria diária quotidien täglich once one two three four five season temporada saison
  organic orgánico organico paid pagado direct directo direto inbound outbound event evento événement webinar trade show feria advertisement anuncio ads ad search búsqueda busqueda display affiliate afiliado
  technology tecnología tecnologia software hardware healthcare sanidad pharma pharmaceutical farmacéutica finance finanzas financial financiero banking banca insurance seguros manufacturing fabricación fabricacion industrial retail comercio wholesale mayorista minorista education educación educacion educação ensino government gobierno governo nonprofit ong fundación fundacion foundation media medios hospitality hostelería hosteleria turismo tourism travel viajes transport transporte logistics logística logistica energy energía energia utilities construction construcción construccion estate inmobiliaria immobilier telecom telecommunications automotive automoción automocion agriculture agricultura food alimentación alimentacion consulting consultoría consultoria real both ambos`
    .split(/\s+/u)
    .filter((word) => word !== '')
    .map(fold),
);

/** Separators between the words of a label; camel humps are split afterwards. */
const WORD_SEPARATORS = /[\s_\-./,;:()[\]{}|&+"'’`#?!*<>=]+/u;
const PROPER_NOUN = /^\p{Lu}[\p{Ll}'’-]{1,19}$/u;
/** One to four tokens of letters from a script without case — CJK, Arabic, Hangul, Hebrew, Thai — with their marks: where no capital can tell a name from a word, a short token has the shape of a name. Georgian is written in Mkhedruli, which Unicode files as lower case though nothing is ever capitalised in it, so it is caseless here too (R2-PC-01, S3c). */
const CASELESS_NAME = /^[\p{Lo}\p{Lm}\p{M}\p{Script=Georgian}]+(?:[\s·・'’.-]+[\p{Lo}\p{Lm}\p{M}\p{Script=Georgian}]+){0,3}$/u;
/** One alphabetic word of any script — letters, marks, apostrophes, dots, hyphens, no space: the shape every single-token name shares with every single-token word, so only a vocabulary can tell them apart. */
const SINGLE_WORD = /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u;
/**
 * A target field whose label or api name says its values are people —
 * owners, assignees, managers, representatives — in the languages of the
 * label list and the scripts picklists come in. This vocabulary is a
 * restriction and nothing more: a field it names drops every option, but a
 * field it does not name gets no permission from that — its options still
 * have to be provably enumeration tokens on their own (R2-PC-06). Comercial,
 * Vendedor, Sales Rep or Менеджер being absent from it widens nothing.
 */
const PERSON_FIELD = /owner(?!ship)|assign|propietari|proprietári|propriétaire|besitzer|responsable|responsável|verantwortlich|manager|gerente|representante|representative|\bagente?\b|担当|负责人|所有者|소유자|담당자/iu;
/**
 * What a label or identifier compound is written with — snake, kebab, dotted,
 * camel, Pascal, the vendor custom-field suffix — is a way of joining pieces,
 * never a reason to admit them (data policy 1.6.0): FirstName, hs_lead_status
 * and Custom_Field__c are structural because *first*, *name*, *hs*, *lead*,
 * *status*, *custom* and *field* are, and OkonkwoNdebele, Okonkwo_Ndebele or
 * Okonkwo__c are not, whatever shape the join gives them. Until revision 009
 * the whole-compound grammars and a two-to-six-capital acronym shape stood
 * here as shapes that admitted a token on their own; SMITH was structural in
 * capitals and a name in title case, and a Pascal compound of two surnames was
 * an identifier. Capitals and joins are not authorisers: a piece is known by
 * the closed lists or it is not.
 */
const VENDOR_SUFFIX = /__c$/u;
const SINGLE_LETTER = /^[A-Za-z]$/u;
/** A word in lower case only: the shape vendors mint api names in (lifecyclestage, jobtitle) — and the shape of a user name (okonkwo). The shape admits nothing (data policy 1.7.0); it is only where the vocabulary segmentation below is read. */
const LOWER_WORD = /^[a-z]+$/u;
/**
 * The words this core's own codes are written with — the compiler's,
 * the kernel's, the run's and the envelope's constants (INVALID_SCHEMA,
 * TARGET_NOT_IN_CONTRACT, UNKNOWN_CANDIDATE_REF, PROVIDER_TERMINAL_FAILURE)
 * — and the verbs vendor schemas are named with (createdate,
 * lastmodifieddate, IsDeleted). A closed list read case-insensitively, as
 * the label vocabulary is: a constant is structural because its words are
 * known, never because it is written in capitals (data policy 1.7.0). No
 * entry is a name in any language.
 */
const CODE_WORDS = new Set(
  `abstain abstained abstention after agency allowed ambiguous another answered api applies apply approved are association attempt attempts authoritative authority before below between billed blocked blocking boolean bound budget bundle but by bytes cache cancelled candidate cap cardinality case class clean clear code column compatible compiler configuration conflict consistency contract convention core coverage create created date deadline decision defers delete deleted derived destructive different digest does domain draft draftable duplicate edited egress email empty enum envelope error evidence evidenced exact exhausted expected facts failed failure fenced field finished for forbidden foreign format formed free full handling has hash hashes header id identifier identity impact in incompatible incomplete inconsistent inexact input insufficient invalid invented is iso item items key label ledger length like long looks low malformed map mapping match matches material member memory metadata migration mismatch model modify multi must name named needs no non normalise not now number object observed of off on only op options or out outcome outside owner param params parse passed phone pii policy populated port potential preserve preserved primitive problems proof proposal propose proven provider rare rationale reached ready reason receipt reconciliation record ref region repair reported representative require required requirement requires reservation resolution resolver response restricted result retryable review run runs safe schema scope select selection semantic semantics send sensitive shape signal stale started stored strategy structural support supported system target targets task tenant terminal text to too transform transformation transition transport trim type under unique unknown unmapped unproven unsatisfied unsupported update usage valid validated validating validation value values verify version view violation vocabulary waiting well whitespace without worker writable write`
    .split(/\s+/u)
    .filter((word) => word !== ''),
);
/** An opaque reference the envelope builder minted for text that may not travel: a short channel prefix and twelve letters of g–v (hdr_…, lbl_…, api_…). Structural on every label channel — it carries nothing — and the egress re-read of a redacted envelope must find it so. */
const OPAQUE_REFERENCE = /^[a-z]{2,6}_[g-v]{12}$/u;
const SMALL_INTEGER = /^\d{1,4}(?:st|nd|rd|th|º|ª|°)?$/u;
const words = (text: string): string[] => text.normalize('NFKC').split(WORD_SEPARATORS).filter((word) => word !== '');
const camelParts = (word: string): string[] => word.split(/(?<=[a-z0-9])(?=[A-Z])/u);
/** The letter runs of a token that carries a digit, the token itself first: zuleika7 is read as zuleika too, ZULEIKA7 as ZULEIKA. */
const letterRuns = (part: string): string[] => (/\d/u.test(part) ? [part, ...part.split(/\d+/u).filter((run) => run !== '')] : [part]);

/** A capitalised token with a family-name ending that is neither label vocabulary nor safe vocabulary: a surname by shape, not by list. */
function familyNameShaped(part: string): boolean {
  return FAMILY_NAME_ENDING.test(part) && !LABEL_WORDS.has(fold(part)) && !SAFE_VOCABULARY.test(part);
}

/** Whether any word of the text — including the parts of a camel or snake identifier, and the letter runs beside a digit — is a given name or has the shape of a family name. */
function namesPerson(text: string): boolean {
  return words(text)
    .flatMap(camelParts)
    .flatMap(letterRuns)
    .some((part) => GIVEN_NAMES.has(fold(part)) || familyNameShaped(part));
}

/** A capitalised alphabetic token, or two to four of them: the shape of a name whatever the list says. */
function properNounShaped(text: string): boolean {
  const parts = text.trim().split(/\s+/u);
  return parts.length >= 1 && parts.length <= 4 && parts.every((part) => PROPER_NOUN.test(part));
}

/** A short text made only of caseless-script letters: a name in a script that has no capitals to give it away. */
function caselessNameShaped(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= 24 && CASELESS_NAME.test(trimmed);
}

/** Whether a field's label or api name says its values are people; the options of such a field are names whatever their shape. */
export function fieldNamesPeople(...texts: readonly string[]): boolean {
  return texts.some((text) => PERSON_FIELD.test(text.normalize('NFKC')));
}

/** Whether a field's label or api name names people or may: the person-field vocabulary, or the wider one read for the homonym tie-break (sellers, users, authors, members, contacts). */
export function fieldMayNamePeople(...texts: readonly string[]): boolean {
  return fieldNamesPeople(...texts) || texts.some((text) => PERSON_LIKE_LABEL.test(text.normalize('NFKC')));
}

/**
 * A single capitalised or upper-case word that is at once a word of the
 * enumeration vocabulary and a family or given name — Klein, Petit, Gross,
 * Grand, Small, Price, Fields, Banks, Day, Gold, Silver, Campos, Casas,
 * Fuentes, Chance, Plata. On its own it passes the OPTION channel as the
 * word; whether it is the word or the name only the list it stands in and
 * the label over it can tell (R2R-PC-03).
 */
export function vocabularyHomonym(text: string): boolean {
  const trimmed = text.normalize('NFKC').trim();
  if (!/^\p{Lu}[\p{L}'’-]{1,19}$/u.test(trimmed)) return false;
  const folded = fold(trimmed);
  return (SURNAMES.has(folded) || GIVEN_NAMES.has(folded)) && enumerationWord(trimmed);
}

/**
 * Whether an option list, read whole, is a list of people: any option of it
 * the OPTION channel refuses as a proper noun makes it one. A homonym in
 * such a list is the surname (Klein beside Zbigniew); in a list of
 * vocabulary words it is the word (Klein beside Gross and Mittel).
 */
export function optionListNamesPeople(options: readonly string[]): boolean {
  return options.some((option) => classifyMetadataText(option, 'OPTION').dataClass === 'POTENTIAL_PII');
}

function labelWord(word: string): boolean {
  const folded = fold(word);
  if (LABEL_WORDS.has(folded) || STOP_WORDS.has(folded)) return true;
  // Plurals of the vocabulary count; nothing else about the word does.
  if (folded.endsWith('es') && LABEL_WORDS.has(folded.slice(0, -2))) return true;
  if (folded.endsWith('s') && LABEL_WORDS.has(folded.slice(0, -1))) return true;
  return false;
}

/** A word of the label vocabulary or of the enumeration vocabulary, plurals included; nothing else about a word counts. */
function enumerationWord(word: string): boolean {
  if (labelWord(word)) return true;
  const folded = fold(word);
  if (ENUMERATION_WORDS.has(folded)) return true;
  if (folded.endsWith('es') && ENUMERATION_WORDS.has(folded.slice(0, -2))) return true;
  if (folded.endsWith('s') && ENUMERATION_WORDS.has(folded.slice(0, -1))) return true;
  return false;
}

/** A word of the safe, label or enumeration vocabulary, plurals included — the stop words excluded: `de`, `en` or `al` beside a digit is no more a word than DE, EN or AL is a code. */
function vocabularyRun(run: string): boolean {
  if (SAFE_VOCABULARY.test(run)) return true;
  const folded = fold(run);
  if (STOP_WORDS.has(folded) && !LABEL_WORDS.has(folded) && !ENUMERATION_WORDS.has(folded)) return false;
  return enumerationWord(run);
}

/**
 * Whether one letter run of a digit-bearing token is known: a single Latin
 * letter standing alone between digits, separators or the ends of the token
 * (the B of B2B, the Q of Q1), a vocabulary word, or a camel compound whose
 * every hump is a vocabulary word of two letters or more (ClosedWon2,
 * closedWon2). A single letter is a symbol only when it is the whole run: a
 * hump of one letter inside a longer run is part of that run, and nG, wU,
 * yN or xStatus are unknown runs however the case changes inside them
 * (revision 009 review, PRIVACY-009-CASE-BYPASS) — capitalisation is not an
 * authoriser, and splitting on it must not become one. The compact prefixes
 * are read by compactVerdict in the first position only; here a prefix is
 * nothing.
 */
function knownRun(run: string): boolean {
  if (LATIN_LETTER.test(run)) return true;
  if (vocabularyRun(run)) return true;
  const humps = camelParts(run);
  return humps.length > 1 && humps.every(compoundHump);
}

/** A hump of a camel compound beside a digit: a vocabulary word of at least two letters. One letter is never a hump — the y of yN1 is not the symbol y, and the G is not the symbol G. */
function compoundHump(hump: string): boolean {
  return [...hump].length >= 2 && vocabularyRun(hump);
}

/**
 * The verdict on a whitespace-free token that carries a digit, by the
 * precedence documented above: CODE, HANDLE, or null when the token carries
 * no digit and the rule has nothing to say. The letter runs are read in
 * every script: a run the vocabulary does not know is unknown whatever it is
 * written in, and a run of one caseless-script letter is not a symbol.
 */
export function compactVerdict(token: string): CompactVerdict | null {
  const text = token.normalize('NFKC');
  // Letters, digits and the separators codes and handles are written with
  // (SKU-0042, PO_2024/07, j.kowalski1). A token with other punctuation in
  // it (Zq7#kL) is neither a code nor a handle by this rule: the other rules
  // leave it UNKNOWN, and UNKNOWN travels no more than a handle does.
  if (!COMPACT_TOKEN.test(text) || !/\p{Nd}/u.test(text)) return null;
  if (MIGRATION_CORE_FILE_ID.test(text)) return 'CODE';
  // A small integer with an ordinal suffix (2nd, 3rd, 1º) is the closed safe vocabulary, not the letters nd, rd or º beside a digit (data policy 1.6.0).
  if (SMALL_INTEGER.test(text)) return 'CODE';
  const runs = text.match(/[\p{L}\p{M}]+/gu) ?? [];
  if (runs.length === 0) return 'CODE';
  const [first, ...rest] = runs;
  // A compact prefix authorises the first run only, and only when the number it counts follows it at once.
  const afterFirst = first === undefined || !text.startsWith(first) ? '' : text.slice(first.length).replace(COMPACT_SEPARATOR, '');
  const prefixed = first !== undefined && COMPACT_PREFIXES.has(fold(first)) && /^\p{Nd}/u.test(afterFirst);
  const judged = prefixed ? rest : runs;
  return judged.every(knownRun) ? 'CODE' : 'HANDLE';
}

/** A code by the compact rule: what a digit-bearing enumeration token or label token may be. */
const codeShaped = (token: string): boolean => compactVerdict(token) === 'CODE';

/** Whether any whitespace-separated token of the text is a handle by the compact rule; a handle anywhere makes the text personal on every channel. */
export function handleIn(text: string): boolean {
  return text
    .normalize('NFKC')
    .split(/\s+/u)
    .map((part) => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}_]+$/gu, ''))
    .some((part) => part !== '' && compactVerdict(part) === 'HANDLE');
}

/** What an enumeration may be written with on its own without being a word: an ISO code the closed lists know, a small integer, a code that carries a digit, a single letter. No bare acronym longer than a code, no Pascal or snake compound and no vendor suffix on its own (data policy 1.6.0: Okonkwo__c was an enumeration by its suffix): those are checked piece by piece, the suffix's `c` among the pieces. */
const ENUMERATION_CODES: readonly { test(piece: string): boolean }[] = [{ test: isoCode }, SMALL_INTEGER, { test: codeShaped }, /^[A-Za-z]$/u];

/** A piece of an enumeration token: the safe vocabulary, a code, or a word a vocabulary knows. */
const enumerationPiece = (piece: string): boolean => SAFE_VOCABULARY.test(piece) || ENUMERATION_CODES.some((shape) => shape.test(piece)) || enumerationWord(piece);

/**
 * Whether a text is provably an enumeration token: the closed safe
 * vocabulary as a whole, or every whitespace-separated part a code, a word
 * the label or enumeration vocabulary knows, or a compound — snake, kebab,
 * dotted, camel, Pascal — whose every piece is one. A word no vocabulary
 * knows fails, capitalised or not and whatever its script: an enumeration is
 * written in words a vocabulary knows, and a name is not. This is the only
 * way an option earns SAFE_STRUCTURAL_METADATA; no label, contract or list
 * widens it.
 */
export function enumerationToken(text: string): boolean {
  const trimmed = text.normalize('NFKC').trim();
  if (trimmed === '') return false;
  if (SAFE_VOCABULARY.test(trimmed)) return true;
  const parts = trimmed.split(/\s+/u);
  if (parts.length > 8) return false;
  const bares = parts.map((part) => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}_]+$/gu, '')).filter((bare) => bare !== '');
  if (bares.length === 0) return false;
  return bares.every((bare) => {
    // A token with a digit is judged whole by the compact rule and never
    // piece by piece: ES-2024 is not the ISO code ES beside the integer
    // 2024, and NDE_8 is not the letters NDE beside the integer 8.
    if (/\p{Nd}/u.test(bare)) return codeShaped(bare);
    if (enumerationPiece(bare)) return true;
    const pieces = bare.split(/[_\-./]+/u).filter((piece) => piece !== '').flatMap(camelParts);
    return pieces.length > 1 && pieces.every(enumerationPiece);
  });
}

/** The bare token of a whitespace-separated part: outer punctuation stripped, a trailing underscore kept. */
const bareOf = (part: string): string => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}_]+$/gu, '');

/** The pieces of a label or identifier compound: the vendor suffix dropped, split on `_ - . /`, then on camel humps. A bare word is its own one piece. */
const compoundPieces = (bare: string): string[] => bare.replace(VENDOR_SUFFIX, '').split(/[_\-./]+/u).filter((piece) => piece !== '').flatMap(camelParts);

/**
 * A piece of a label that is known on its own: a small integer, a word of the
 * label vocabulary (plurals included, stop words included), an ISO code the
 * closed lists know, a single letter, or — when it carries a digit — a code
 * by the compact rule. Case is read into the lookup, never as a rule.
 */
function knownLabelPiece(piece: string): boolean {
  if (SMALL_INTEGER.test(piece) || labelWord(piece) || isoCode(piece) || SINGLE_LETTER.test(piece)) return true;
  if (CODE_WORDS.has(fold(piece)) || vocabularyCompound(piece)) return true;
  return /\p{Nd}/u.test(piece) && codeShaped(piece);
}

/** The words a lower-case concatenation may be read as: the label, enumeration and code vocabularies, three letters or more, and the connectives `of` and `id`. */
const SEGMENT_WORDS: ReadonlySet<string> = new Set([...LABEL_WORDS, ...ENUMERATION_WORDS, ...CODE_WORDS].filter((word) => /^[a-z]{3,}$/u.test(word)).concat(['of', 'id']));

/**
 * Whether a lower-case piece is two or more vocabulary words written
 * together — the way vendors mint api names: lifecyclestage (lifecycle,
 * stage), jobtitle, mobilephone, numberofemployees, createdate,
 * associatedcompanyid (data policy 1.7.0). Every letter of the piece must be
 * inside a word the vocabulary knows; a name is not a concatenation of words
 * (okonkwo, vaskemar), and the lower-case shape admits nothing by itself.
 * Only lower case is read so: a title-case or upper-case piece is one word
 * or unknown.
 */
function vocabularyCompound(piece: string): boolean {
  if (!LOWER_WORD.test(piece) || piece.length < 5 || piece.length > 48) return false;
  // A name the lists know is a name, however it splits: rolland is not rol and land.
  if (SURNAMES.has(piece) || GIVEN_NAMES.has(piece)) return false;
  // fewest[i]: the fewest vocabulary words piece.slice(0, i) splits into, or Infinity.
  const fewest: number[] = [0, ...Array.from({ length: piece.length }, () => Number.POSITIVE_INFINITY)];
  for (let end = 1; end <= piece.length; end += 1) {
    for (let start = Math.max(0, end - 24); start < end; start += 1) {
      const before = fewest[start] ?? Number.POSITIVE_INFINITY;
      if (before !== Number.POSITIVE_INFINITY && SEGMENT_WORDS.has(piece.slice(start, end))) fewest[end] = Math.min(fewest[end] ?? Number.POSITIVE_INFINITY, before + 1);
    }
  }
  const count = fewest[piece.length] ?? Number.POSITIVE_INFINITY;
  return count >= 2 && count !== Number.POSITIVE_INFINITY;
}

/**
 * Every word of the text is a known piece or a compound of known pieces
 * (data policy 1.6.0). No shape admits a token on its own: not an acronym of
 * two to six capitals (SMITH, LEE, CRM — the last is vocabulary, the first
 * two are not), not a snake, kebab, dotted, camel or Pascal join
 * (Okonkwo_Ndebele, OkonkwoNdebele), not the vendor suffix (Okonkwo__c).
 */
function structural(text: string): boolean {
  const parts = text.normalize('NFKC').trim().split(/\s+/u).filter((part) => part !== '');
  if (parts.length === 0 || parts.length > 8) return false;
  return parts.every((part) => {
    const bare = bareOf(part);
    if (bare === '' || OPAQUE_REFERENCE.test(bare)) return true;
    // A token with a digit is a code by the compact rule or nothing: Q1, phone2, Address2, Custom_Field_2__c pass, HENDERSON7 and ES-2024 do not.
    if (/\p{Nd}/u.test(bare)) return codeShaped(bare);
    if (knownLabelPiece(bare)) return true;
    const pieces = compoundPieces(bare);
    return pieces.length > 1 && pieces.every(knownLabelPiece);
  });
}

/** A piece written as a proper noun — one capital, then lower case — that no vocabulary knows: the shape of a name inside a compound (the Okonkwo of OkonkwoNdebele) as much as alone. */
const properNounPiece = (piece: string): boolean => PROPER_NOUN.test(piece) && !labelWord(piece) && !enumerationWord(piece);

/** Whether a text has the shape of a name on the label channels: capitalised words, a caseless-script name, or a compound — joined, not spaced — with a proper-noun piece in it. A word beside a separate integer (Mystery 1) is still merely unknown. */
function nameShaped(text: string): boolean {
  const trimmed = text.normalize('NFKC').trim();
  return properNounShaped(trimmed) || caselessNameShaped(trimmed) || joinedNameShaped(trimmed);
}

/**
 * The part of the name shape that the capitalised-word and caseless-script
 * rules do not read: a compound — joined, not spaced — with a proper-noun
 * piece in it (OndrielVaskemar, Okonkwo_Ndebele), or a proper noun before
 * the vendor suffix (Pelsira__c). The value and OPTION channels read this
 * part alone after their own proper-noun and caseless rules (data policy
 * 1.7.0), so each rule stays the only one that reads its shape.
 */
function joinedNameShaped(text: string): boolean {
  return text.split(/\s+/u).some((part) => {
    const bare = bareOf(part);
    const pieces = compoundPieces(bare);
    return (pieces.length > 1 || VENDOR_SUFFIX.test(bare)) && pieces.some(properNounPiece);
  });
}

/**
 * The IDENTIFIER channel (data policy 1.7.0): api names, object names, types,
 * file ids, sheet names, memory types and validation codes. A token of the
 * identifier grammar is an identifier when every piece of it is known: a
 * known label piece, a word of the code or enumeration vocabulary in any
 * case (INVALID_SCHEMA, TARGET_NOT_IN_CONTRACT, Enterprise_Tier), or a
 * lower-case concatenation of vocabulary words (lifecyclestage, jobtitle).
 * Case admits nothing: until data policy 1.7.0 any lower-case word and any
 * upper-case piece of a compound were admitted by their case, and okonkwo,
 * okonkwo_ndebele, j.kowalski and OKONKWO_NDEBELE travelled as api names and
 * repair codes (independent review of the retained candidate,
 * PRIVACY-IDENTIFIER-CASE-BYPASS). A piece in title case that no vocabulary
 * knows is a proper noun — Okonkwo, Birthdate — and makes the token personal;
 * any other unknown piece leaves it UNKNOWN. Either way it travels as an
 * opaque reference, never as text.
 */
function identifierVerdict(text: string, instructionLike: boolean): Classification {
  if (!IDENTIFIER_PATTERN.test(text) || text.length > 64) return { dataClass: 'UNKNOWN', reason: 'not an identifier', instructionLike };
  if (OPAQUE_REFERENCE.test(text)) return { dataClass: 'SAFE_STRUCTURAL_METADATA', reason: 'opaque reference', instructionLike };
  if (/\p{Nd}/u.test(text)) return codeShaped(text) ? { dataClass: 'SAFE_STRUCTURAL_METADATA', reason: 'identifier', instructionLike } : { dataClass: 'UNKNOWN', reason: 'identifier with a digit outside the compact rule', instructionLike };
  const pieces = compoundPieces(text);
  const known = (piece: string): boolean => knownLabelPiece(piece) || enumerationWord(piece);
  if (pieces.length > 0 && pieces.every(known)) return { dataClass: 'SAFE_STRUCTURAL_METADATA', reason: 'identifier', instructionLike };
  if (pieces.some(properNounPiece)) return { dataClass: 'POTENTIAL_PII', reason: 'proper noun in an identifier: a name, whatever the grammar says', instructionLike };
  return { dataClass: 'UNKNOWN', reason: 'identifier outside every vocabulary', instructionLike };
}

/**
 * The rules that apply to any text whatever its channel: suspicious unicode,
 * secrets, instructions, financial numbers, personal data by shape. They
 * come first in every classifier; null means none of them fired.
 */
function hardRule(text: string, instructionLike: boolean, where: string): Classification | null {
  if (SUSPICIOUS_UNICODE.test(text)) return { dataClass: 'UNKNOWN', reason: `suspicious unicode in ${where}`, instructionLike };
  if (SECRET_SHAPES.some((shape) => shape.test(text))) return { dataClass: 'POTENTIAL_SECRET', reason: `secret shape in ${where}`, instructionLike };
  if (instructionLike) return { dataClass: 'FREE_TEXT', reason: `${where} reads as an instruction`, instructionLike };
  if (CARD.test(text) || IBAN.test(text)) return { dataClass: 'SENSITIVE_OR_RESTRICTED', reason: `financial number in ${where}`, instructionLike };
  if (EMAIL.test(text) || PHONE.test(text) || NATIONAL_ID.test(text) || ADDRESS_TEXT.test(text)) return { dataClass: 'POTENTIAL_PII', reason: `personal datum by shape in ${where}`, instructionLike };
  return null;
}

/** Whether a target option is one the OPTION channel lets travel: only such an option is an authority a value can be safe by. */
export function vettedOption(option: string): boolean {
  const classification = classifyMetadataText(option, 'OPTION');
  return classification.dataClass === 'SAFE_STRUCTURAL_METADATA' && !classification.instructionLike;
}

/** Letters, marks, digits and the joiners `_ . -`: what a user name, a slug or a custom api name is written with. */
const JOINED_TOKEN = /^[\p{L}\p{M}\p{Nd}_.-]+$/u;

/**
 * Whether a value is a handle without a digit (data policy 1.7.0): one
 * token joined by underscores — snake case, or the vendor suffix — with a
 * letter piece no vocabulary knows: ondriel_vaskemar, pelsira__c,
 * j_kowalski. A user name, or a custom api name made of a person's name, and
 * personal on the value channel, never merely UNKNOWN; a joined token whose
 * every piece is vocabulary (closed_won, opt_in) is not one, and an opaque
 * reference this core minted is not one either.
 */
export function joinedHandle(text: string): boolean {
  const token = text.normalize('NFKC').trim();
  if (!JOINED_TOKEN.test(token) || !token.includes('_') || OPAQUE_REFERENCE.test(token)) return false;
  const pieces = compoundPieces(token).filter((piece) => /\p{L}/u.test(piece));
  return pieces.some((piece) => !knownLabelPiece(piece) && !enumerationPiece(piece));
}

/** The class of a candidate value, given the field it comes from, the options its targets offer, and the options of those targets the OPTION channel refused as personal. */
export function classifyValue(value: string, context: { header: string; distinctCount: number | null; rowCount: number; shapeCandidates: readonly string[]; targetOptions?: readonly string[]; personalOptions?: readonly string[] }): Classification {
  const text = value ?? '';
  const instructionLike = INSTRUCTION_LIKE.test(text);
  if (SUSPICIOUS_UNICODE.test(text)) return { dataClass: 'UNKNOWN', reason: 'suspicious unicode', instructionLike };
  if (SECRET_SHAPES.some((shape) => shape.test(text))) return { dataClass: 'POTENTIAL_SECRET', reason: 'secret shape', instructionLike };
  if (SENSITIVE_HEADER.test(context.header) || CARD.test(text) || IBAN.test(text)) return { dataClass: 'SENSITIVE_OR_RESTRICTED', reason: 'sensitive header or financial/identity number', instructionLike };
  if (EMAIL.test(text) || PHONE.test(text) || ADDRESS_HEADER.test(context.header) || headerNamesPerson(context.header) || NATIONAL_ID.test(text)) return { dataClass: 'POTENTIAL_PII', reason: 'personal datum by shape or header', instructionLike };
  if (ADDRESS_TEXT.test(text)) return { dataClass: 'POTENTIAL_PII', reason: 'address-like text', instructionLike };
  // A given name is personal under any header and at any cardinality; the
  // list is checked before any rule that could call the token safe.
  if (namesPerson(text)) return { dataClass: 'POTENTIAL_PII', reason: 'given name', instructionLike };
  // A token with a digit whose letters no vocabulary knows is a handle —
  // someone's name and a number — under any header, at any cardinality and
  // whatever option list is handed in: personal, never merely unknown.
  if (handleIn(text)) return { dataClass: 'POTENTIAL_PII', reason: 'handle: an unknown letter run beside a digit', instructionLike };
  if (instructionLike) return { dataClass: 'FREE_TEXT', reason: 'reads as an instruction', instructionLike };
  if (text.length > 64 || /\s.*\s.*\s/u.test(text)) return { dataClass: 'FREE_TEXT', reason: 'long or sentence-like', instructionLike };
  const lowCardinality = context.distinctCount !== null && context.distinctCount <= 32 && context.rowCount >= context.distinctCount;
  const trimmed = text.trim();
  // Safe semantics are safe by authority, never by shape: the closed
  // vocabulary, or the option list of the target the value could map to.
  if (lowCardinality && (SAFE_VOCABULARY.test(trimmed) || isoCode(trimmed))) return { dataClass: 'SAFE_LOW_CARDINALITY_SEMANTICS', reason: 'closed safe vocabulary', instructionLike };
  // An option vouches for a value only when the option itself would pass
  // the OPTION channel: the list a caller hands in is read, not trusted,
  // so a person's name in a picklist never widens what may travel.
  if (lowCardinality && (context.targetOptions ?? []).some((option) => option.trim().toLowerCase() === trimmed.toLowerCase() && vettedOption(option))) return { dataClass: 'SAFE_LOW_CARDINALITY_SEMANTICS', reason: 'matches a target option', instructionLike };
  // The same reading in the other direction (data policy 1.7.0): a value its
  // target lists as an option the OPTION channel refused as personal is the
  // person the option is — VASKEMAR under a list that names it is a name, as
  // a value exactly as in the list — and no exemplar of it leaves, not even
  // a masked one.
  if ((context.personalOptions ?? []).some((option) => fold(option.trim()) === fold(trimmed))) return { dataClass: 'POTENTIAL_PII', reason: 'a target lists it among options that are people', instructionLike };
  // Two or three capitals the closed lists do not know and no option vouches
  // for: LEE, WU, LIM, HO — a code or a surname, and nothing in the token
  // tells which, so not even a shape leaves (R2R-PC-01).
  if (ISO_SHAPE.test(trimmed)) return { dataClass: 'UNKNOWN', reason: 'short upper-case token outside the ISO lists', instructionLike };
  if (joinedHandle(trimmed)) return { dataClass: 'POTENTIAL_PII', reason: 'handle: a joined token with a piece no vocabulary knows', instructionLike };
  if (properNounShaped(trimmed)) return { dataClass: 'POTENTIAL_PII', reason: 'proper-noun shape', instructionLike };
  // A short token in a script without case is a name unless the target's
  // own options said otherwise above: no capital gives it away, so the
  // shape does — a name in Chinese is still a name.
  if (caselessNameShaped(trimmed)) return { dataClass: 'POTENTIAL_PII', reason: 'name shape in a caseless script', instructionLike };
  // A proper noun joined into a compound or before the vendor suffix —
  // OndrielVaskemar, Pelsira__c — is the name the label channels read in it
  // (data policy 1.7.0); left UNKNOWN it failed the whole task closed, and a
  // column of suffixed names took the provider request down with it.
  if (joinedNameShaped(trimmed)) return { dataClass: 'POTENTIAL_PII', reason: 'name shape: a proper noun joined into a compound', instructionLike };
  // Plain words with no vocabulary behind them are text: at most a masked
  // shape leaves, and only when the task needs one.
  if (/^\p{L}[\p{L}\s'’.-]*$/u.test(trimmed)) return { dataClass: 'FREE_TEXT', reason: 'words with no vocabulary rule', instructionLike };
  return { dataClass: 'UNKNOWN', reason: 'no rule accepts it', instructionLike };
}

/**
 * Headers, labels, memory patterns, options and identifiers: the hard rules
 * first, then the allow-list of the channel. What is not provably structural
 * is UNKNOWN and travels as a token, never as text.
 */
export function classifyMetadataText(text: string, kind: MetadataKind = 'LABEL'): Classification {
  const instructionLike = INSTRUCTION_LIKE.test(text);
  const hard = hardRule(text, instructionLike, 'metadata');
  if (hard !== null) return hard;
  if (namesPerson(text)) return { dataClass: 'POTENTIAL_PII', reason: 'person-name-like token in metadata', instructionLike };
  // The compact rule reads every channel alike before the channel's own
  // allow-list and before any length rule: a handle is personal as an
  // option, a label, an api name, a memory pattern or a repair code, no
  // identifier grammar admits it, and no length turns it into free text
  // (revision 009 review, PRIVACY-009-LENGTH-BYPASS).
  if (handleIn(text)) return { dataClass: 'POTENTIAL_PII', reason: 'handle in metadata: an unknown letter run beside a digit', instructionLike };
  if (text.length > 96) return { dataClass: 'FREE_TEXT', reason: 'metadata too long to be a label', instructionLike };
  if (kind === 'IDENTIFIER') return identifierVerdict(text, instructionLike);
  if (kind === 'OPTION') {
    // The contract vouches for an enumeration, never for a person, and the
    // label of the field cannot widen this (R2-PC-01): an option travels
    // only when it is provably an enumeration token. A single word no
    // vocabulary knows is a proper noun whatever its case or script — Iker,
    // Светлана, გიორგი, Γιώργος and Okonkwo have no shape that separates
    // them from Enterprise, 山田太郎 none from 企业 — and so are two or more
    // capitalised words. What is neither is unknown; nothing here is safe.
    if (enumerationToken(text)) return { dataClass: 'SAFE_STRUCTURAL_METADATA', reason: 'enumeration token: closed vocabulary, code or vocabulary words', instructionLike };
    const trimmed = text.trim();
    // Two or three capitals outside the closed code lists are a code or a
    // surname — LEE, WU, LIM — and nothing in the token tells which (R2R-PC-01).
    if (ISO_SHAPE.test(trimmed)) return { dataClass: 'UNKNOWN', reason: 'short upper-case option outside the ISO lists', instructionLike };
    if (SINGLE_WORD.test(trimmed) || properNounShaped(trimmed) || caselessNameShaped(trimmed)) return { dataClass: 'POTENTIAL_PII', reason: 'word outside every enumeration vocabulary in an option: a proper noun, whatever the label says', instructionLike };
    // A joined handle or a name joined into a compound or before the vendor suffix is a person as an option as much as a value (data policy 1.7.0): the list that holds one is a list of people.
    if (joinedHandle(trimmed) || joinedNameShaped(trimmed)) return { dataClass: 'POTENTIAL_PII', reason: 'handle or joined name in an option', instructionLike };
    return { dataClass: 'UNKNOWN', reason: 'option outside every enumeration vocabulary', instructionLike };
  }
  if (structural(text)) return { dataClass: 'SAFE_STRUCTURAL_METADATA', reason: 'structural metadata', instructionLike };
  // A name by shape: capitalised words, a caseless-script name, or a proper
  // noun joined into a compound (OkonkwoNdebele, Okonkwo_Ndebele). A bare
  // word in capitals outside every list (SMITH, LEE) is a constant or a
  // surname and nothing tells which: UNKNOWN, never structural by its case.
  if (nameShaped(text)) return { dataClass: 'POTENTIAL_PII', reason: 'person-name shape in metadata', instructionLike };
  return { dataClass: 'UNKNOWN', reason: 'metadata with no structural rule', instructionLike };
}

/**
 * The masked form of a value: capitals to A, every other letter of every
 * script to a, digits to 9, combining marks dropped, everything else kept —
 * a shape, not a datum. Letters without case fold too, or a name in a
 * caseless script would be its own shape.
 */
export function maskShape(value: string): string {
  return [...value]
    .slice(0, 32)
    .join('')
    .replace(/\p{M}/gu, '')
    .replace(/(?!\p{Lu})\p{L}/gu, 'a')
    .replace(/\p{Lu}/gu, 'A')
    .replace(/\p{N}/gu, '9');
}
