// The words of the three legal documents (design D-LEGAL-1; manual 19 "Service terms: required operative content", "Data processing
// agreement", "Subprocessor register", "Rights requests and privacy complaints", "Incident and breach obligations"; A3 rules 3.3 and 3.7).
//
// A template is a function of the resolved operator facts: it holds every clause of the document and no fact of its own. It has no
// company name, address, tax number, law, forum or provider in it (a test walks the site for that), and it states nothing the manuals
// leave to the operator's reviewer: liability, governing law and forum arrive as facts. Numbers come from the vendored policy snapshot
// and the retention module, so a document cannot state a window the policy does not hold.
//
// The output is data, not markup: a title, a one-sentence promise and sections of paragraphs and list items. The renderer serializes it
// to the text that the version label hashes and escapes it into HTML; neither step adds a word.
import { POLICY_SNAPSHOT } from "../public/policy-snapshot.ts";
import { DEFECT_CLAIM_DAYS, DEFECT_REPAIR_BUSINESS_DAYS, DOWNLOAD_LINK_MINUTES, RETENTION_ROWS, REUPLOAD_NOTICE } from "../public/retention.ts";

export interface ResolvedSubprocessor {
  readonly name: string;
  readonly purpose: string;
  readonly location: string;
  readonly transferBasis: string;
}

/** The facts of a complete set as plain text (gapsOf is empty): the citation of each fact is not part of a document. */
export interface ResolvedFacts {
  readonly legalName: string;
  readonly entityType: string;
  readonly taxId: string;
  readonly registeredAddress: string;
  readonly postalContact: string;
  readonly legalEmail: string;
  readonly governingLaw: string;
  readonly forum: string;
  readonly liability: string;
  readonly effectiveDate: string;
  readonly subprocessors: readonly ResolvedSubprocessor[];
}

export interface Section {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  /** A list after the paragraphs. */
  readonly items?: readonly string[];
}

export interface Template {
  readonly title: string;
  /** The page's promise in one sentence (interface contract UI45 to UI47, primary copy). */
  readonly primary: string;
  readonly sections: (facts: ResolvedFacts) => readonly Section[];
}

const identity = (f: ResolvedFacts): string =>
  `${f.legalName} (${f.entityType}, tax ID ${f.taxId}) operates Kauro. Its registered address is ${f.registeredAddress}. Its postal contact is ${f.postalContact}. Its legal contact is ${f.legalEmail}.`;

const retentionItems = (): readonly string[] => RETENTION_ROWS.map((row) => `${row.subject}: ${row.rule}`);

const subprocessorItems = (f: ResolvedFacts): readonly string[] =>
  f.subprocessors.map((s) => `${s.name}: ${s.purpose}. Location: ${s.location}. Transfer basis: ${s.transferBasis}.`);

const EXCLUDED_DATA =
  "Credentials and authentication secrets, full payment card data, health data that needs arrangements the service does not have, and any other category whose obligations or security needs go beyond the qualified service are not accepted.";

const NOTES_WARNING =
  "A field called notes can hold sensitive information. The checks Kauro runs on uploaded content reduce that risk but cannot promise to find every case, so do not upload material from the excluded categories.";

const VERSIONS = (what: string): Section => ({
  heading: "Changes and versions",
  paragraphs: [
    `A change to ${what} is published as a new version with its own effective date. The version label at the top of this page names the document, its effective date and a digest of its exact text, so a label always identifies the same words. An order keeps the version its customer accepted; a later edit to this page does not amend it.`,
  ],
});

const CONTACT = (f: ResolvedFacts): Section => ({
  heading: "Contact",
  paragraphs: [`Write to ${f.legalEmail}, or by post to ${f.postalContact}.`],
});

export const TERMS: Template = {
  title: "Service terms",
  primary: "Read the scope before you buy.",
  sections: (f) => [
    {
      heading: "Who provides the service",
      paragraphs: [identity(f), `These terms take effect on ${f.effectiveDate}. They apply to orders accepted on or after that date and never replace the terms an earlier order accepted.`],
    },
    {
      heading: "What makes up the agreement",
      paragraphs: [
        "The service relationship consists of the operator identity above, these service terms, the data processing terms, the privacy notice, the subprocessor and transfer disclosures, the retention schedule, the support and remedy terms below, and the order for the project. The order names the exact scope that was bought and its price. A later edit to a page of this website does not amend an order that was accepted.",
      ],
    },
    {
      heading: "What the service is",
      paragraphs: [
        "Kauro prepares files. It cleans and prepares exported files and produces a package for import; it does not connect to, change or delete records in a live CRM. The customer's team imports the package with its own tools and is responsible for that import. Kauro qualifies imports only for the destinations that the published capability list names as available.",
        "The free data health check is free and creates no obligation to buy. It is bounded by the published limits and is not always immediately available.",
      ],
      items: [
        "Files: the exported CRM data and spreadsheets that an authorized user uploads.",
        "Source revision: the exact set of files sealed for a project. A different set of files is a new revision.",
        "Plan: the changes proposed for a source revision, which the customer decides on.",
        "Package: the prepared files, the report and the manifest delivered for a plan the customer approved.",
        "Target contract: the destination structure a package is prepared for.",
        "Supported profile: a combination of mode, object and operation that the published capability list marks as available.",
        "Service completion: the point at which the ordered package is ready for the customer to download.",
        "Authorized users: the people the customer lets act for it in the application.",
      ],
    },
    {
      heading: "The customer's authority",
      paragraphs: [
        "The customer represents that it has the authority to submit the data it uploads, to have that data processed, and to make the decisions Kauro asks it to make about meaning, such as which records describe the same person or company. An agency makes this representation for its end client's data. An in-house team makes it for its own company's data.",
        "If an instruction appears unlawful or outside the scope of the order, Kauro can ask for evidence or suspend the affected processing. The representation does not excuse Kauro from its own obligations.",
        EXCLUDED_DATA,
        NOTES_WARNING,
      ],
    },
    {
      heading: "Orders, price and scope",
      paragraphs: [
        `An order states the mode, the counted source units, the price, any discount, taxes, the delivery scope and any stage deadlines. A price shown on the website is an indicative band. The price that binds is the quote Kauro issues from the sealed scope, which stays open for ${POLICY_SNAPSHOT.quoteDays} days.`,
        "New customer scope needs a new accepted order or an amendment. Technical repair of a defect in Kauro's work is not a new purchase and is not charged.",
      ],
    },
    {
      heading: "Remedy for a Kauro defect",
      paragraphs: [
        `Report a defect within ${DEFECT_CLAIM_DAYS} after the ordered package was completed. Kauro investigates, and repairs or regenerates the affected part with an initial target of ${DEFECT_REPAIR_BUSINESS_DAYS} from the verified claim. If a material defect caused by Kauro remains unremedied, the applicable refund is due under the order.`,
        "Kauro tells errors in the source files, edits made by the customer, changes to the target and tool settings apart from its own defects, and does not assume that the customer is at fault. Rights that cannot lawfully be excluded stay in place. The retention schedule below explains how the removal of files can affect a later claim.",
      ],
    },
    {
      heading: "Cancellation",
      paragraphs: [
        "A customer can cancel a project. What cancellation means depends on the phase the project has reached: it stops future work, and refunds follow the order and that phase.",
        "Cancellation does not undo effects that already happened outside Kauro. It cannot erase an import that the customer's team already made into its CRM, and it does not promise that no provider cost was incurred.",
      ],
    },
    {
      heading: "Retention and deletion",
      paragraphs: [
        "Kauro keeps files and results only for the windows below. A day is an elapsed period of twenty-four hours.",
      ],
      items: retentionItems(),
    },
    {
      heading: "Early deletion",
      paragraphs: [
        "To delete sooner, an authorized user asks for early deletion in the project or writes to the legal contact. Kauro confirms what will be deleted and on what date, and then deletes it.",
        "Financial and legal records that the law requires are kept apart from CRM contents, for the period the applicable rules set.",
        REUPLOAD_NOTICE,
        `A download link works for ${DOWNLOAD_LINK_MINUTES}.`,
      ],
    },
    {
      heading: "Confidentiality",
      paragraphs: [
        "Each party keeps the other's nonpublic information confidential and uses it only to provide or use the service. This does not apply to information that is public without a breach, that the receiving party already held or lawfully received from someone else, or that the law requires it to disclose.",
      ],
    },
    {
      heading: "Intellectual property",
      paragraphs: [
        "Kauro owns its software and the way the service works. The customer, or the client an agency acts for, keeps its data and its branding, and Kauro does not claim ownership of customer records. Deliverables generated for an order are provided for the customer's use in the project they were ordered for.",
      ],
    },
    {
      heading: "Liability, governing law and forum",
      paragraphs: [`Liability, exclusions and the dispute procedure: ${f.liability}`, `These terms are governed by ${f.governingLaw}. The forum for disputes is ${f.forum}.`],
    },
    VERSIONS("these terms"),
    CONTACT(f),
  ],
};

export const PRIVACY: Template = {
  title: "Privacy notice",
  primary: "Understand how your information is handled.",
  sections: (f) => [
    {
      heading: "Who is responsible",
      paragraphs: [
        identity(f),
        `This notice takes effect on ${f.effectiveDate}.`,
        "For the business contact details of the people who write to Kauro or hold an account, Kauro decides why and how the information is used. For the CRM data that a customer uploads, Kauro acts as a processor on the customer's instructions, as the data processing terms describe, and the customer decides why that data is processed.",
      ],
    },
    {
      heading: "What information is handled and why",
      paragraphs: ["Kauro handles the following, each for the purpose stated."],
      items: [
        "Contact and account details of the people who use Kauro, such as name, business e-mail, role and company: to answer inquiries, run accounts and orders, and send the notices a service needs.",
        "The answers given on the contact form, such as buyer type, destination, approximate size, timeline and a short description: to judge whether the service fits and to reply.",
        "The CRM files that a customer uploads and the data derived from them, such as profiles, proposals, decisions and delivery packages: to prepare the delivery the customer ordered.",
        "A limited context for a model-assisted proposal, sent only to a model provider listed below and deleted with the project data it came from.",
        "Minimized operational and security records that hold no CRM content and no secrets: to run the service safely.",
      ],
    },
    {
      heading: "What Kauro does not accept",
      paragraphs: [
        EXCLUDED_DATA,
        NOTES_WARNING,
        "If prohibited material is found, Kauro pauses the affected work, limits access, tells the authorized contact and follows the deletion and incident procedure. It does not copy the material into a support case or a model prompt to explain the problem.",
      ],
    },
    {
      heading: "Where information is processed and who receives it",
      paragraphs: [
        "These providers process information under Kauro's instructions. No provider receives raw CRM files merely because it is one of Kauro's business vendors.",
      ],
      items: subprocessorItems(f),
    },
    {
      heading: "Providers that decide for themselves",
      paragraphs: [
        "A provider that handles payment or a legal duty for its own purposes can be an independent controller of that information rather than a processor. Such a provider is not listed above as a processor.",
      ],
    },
    {
      heading: "How long information is kept",
      paragraphs: ["Kauro keeps information only for the windows below. A day is an elapsed period of twenty-four hours."],
      items: retentionItems(),
    },
    {
      heading: "Your rights",
      paragraphs: [
        "Depending on the law that applies and on your role, you can ask for access, correction, deletion, restriction or objection. These requests can have different consequences, and Kauro explains the one that applies to yours.",
        "A request is checked and limited to what it covers before anything is disclosed or deleted. CRM data can belong to a customer of Kauro, and that customer decides how its own data is handled, so Kauro coordinates with the customer instead of giving one person's record to someone it has not verified. Kauro keeps only the minimum needed to show that a request was made and answered.",
        "A deletion request does not remove records that the law requires Kauro to keep, such as invoices. Kauro explains which records remain and why.",
      ],
    },
    {
      heading: "Privacy requests and complaints",
      paragraphs: [
        `Send a request or a complaint to ${f.legalEmail}, or by post to ${f.postalContact}. Kauro records the date it received the request and the deadline that the applicable law sets, and answers within it.`,
      ],
    },
    {
      heading: "Security incidents",
      paragraphs: [
        "If an incident affects information, Kauro identifies what was affected, contains it, and notifies the people and authorities that the law and its contracts require. It gives the facts it knows first and updates them as the investigation continues.",
      ],
    },
    VERSIONS("this notice"),
    CONTACT(f),
  ],
};

export const DATA_PROCESSING: Template = {
  title: "Data processing terms",
  primary: "Know the responsibilities for client data.",
  sections: (f) => [
    {
      heading: "Parties and roles",
      paragraphs: [
        identity(f),
        `These terms take effect on ${f.effectiveDate}. In them Kauro is the processor, or the sub-processor where the chain below says so.`,
        "The roles follow the processing that is actually done, and the order or the project record names the controller and the chain of authority for each project. Kauro does not assume that every agency owns all the data it uploads.",
      ],
      items: [
        "An agency can be the controller of its own business data and a processor of its end client's CRM data. Where it is a processor, the end client is the controller and Kauro acts on the agency's instructions.",
        "An in-house team's company is the controller of its own CRM data and Kauro is its processor. This is a chain of two parties: the company and Kauro.",
      ],
    },
    {
      heading: "Instructions",
      paragraphs: [
        "Kauro processes personal data only on the customer's documented instructions. They are these terms, the order and the decisions that the customer's authorized users record in the application.",
        "The processing covers file receipt, inspection, profiling, bounded semantic proposal, deterministic transformation, validation, delivery, support and deletion.",
        "An instruction to keep data indefinitely, to process a category of sensitive data the service does not support, or to send raw records to a model provider that is not approved is rejected or sent for separate review.",
      ],
    },
    {
      heading: "Data and people concerned",
      paragraphs: [
        "The service takes ordinary business CRM data within the order: contact, company, deal and activity records and similar fields, and the people they describe, such as the controller's customers, prospects, contacts and staff.",
        EXCLUDED_DATA,
      ],
    },
    {
      heading: "Confidentiality and security",
      paragraphs: [
        "Kauro requires the people who can reach the data to keep it confidential. It keeps each customer's files and results apart from every other customer's, limits access to what the work needs, and applies security measures suited to the risk.",
      ],
    },
    {
      heading: "Rights requests and incidents",
      paragraphs: [
        "Kauro helps the controller answer a rights request to the extent of what the service holds, and does not answer it on the controller's behalf without instruction.",
        "Kauro tells the customer without undue delay once it becomes aware of an incident that affects the customer's data. It states the facts it knows and when the next update will come, and does not wait for a full root cause.",
      ],
    },
    {
      heading: "Subprocessors",
      paragraphs: [
        "Kauro uses these subprocessors for the customer's data. It stays responsible for how they handle it.",
      ],
      items: subprocessorItems(f),
    },
    {
      heading: "Changing a subprocessor",
      paragraphs: [
        "Kauro reviews the data flow and the contract before it adds or replaces a subprocessor, has a plan for exit and deletion, and gives the customer notice where these terms or the law require it.",
      ],
    },
    {
      heading: "International transfers",
      paragraphs: [
        "The transfer basis of each subprocessor is listed above. Whether a transfer is lawful depends on the roles, the data and the places involved: hosting in a given country is neither automatically sufficient nor automatically forbidden.",
      ],
    },
    {
      heading: "Return and deletion",
      paragraphs: [
        "When the retention windows of the service terms end, or earlier when the customer asks, Kauro deletes the customer's data and can confirm that it did. Records that the law requires are kept apart from CRM contents.",
      ],
    },
    {
      heading: "Evidence of compliance",
      paragraphs: [
        "On request Kauro provides the evidence needed to show that it meets these terms, such as its records of what it processed and when it deleted it, within the limits of confidentiality and of other customers' data.",
      ],
    },
    {
      heading: "Governing law and forum",
      paragraphs: [`These terms are governed by ${f.governingLaw}. The forum for disputes is ${f.forum}.`],
    },
    VERSIONS("these terms"),
    CONTACT(f),
  ],
};
