/**
 * Application contracts of the agency recurrence and commission domain (package B10; docs/design/B10-commercial-domain.md): the six
 * self-contained ports and the two shipped bindings that need no database, the command specs of CMD002, CMD027, CMD043 and
 * CMD045..CMD053, their closed request schemas, the DTO views and their closed response schemas (with the GetCommissionStatement
 * read), and the commercial authorizer. The handlers, the adapters and the routes are the later lanes of the package; the labelled
 * contract fakes of the ports are the test-only subpath @kauro/application/testing and are deliberately not exported here. Since
 * B10-AGENCY-LIFECYCLE the package also serves CMD002 and CMD043 (outcomes, served, agency).
 */
export * from "./ports.js";
export * from "./bindings.js";
export * from "./vocabulary.js";
export * from "./views.js";
export * from "./contracts.js";
export * from "./request-schemas.js";
export * from "./response-schemas.js";
export * from "./authorizer.js";
export * from "./outcomes.js";
export * from "./served.js";
export * from "./agency/index.js";
export * from "./prospects/index.js";
export * from "./sellers/index.js";
export * from "./quotes/index.js";
