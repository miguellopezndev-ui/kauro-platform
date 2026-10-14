/**
 * The handler files of package B12's lanes (plan docs/design/B12-outreach-plan.md §9), each a NOT_BUILT stub until its lane lands it
 * (lane K1 creates the files so that lanes edit disjoint files and nothing imports a missing module). A stub never touches a port, a
 * pool or a row: calling it throws OutreachNotBuilt, which no route maps to a success (the lane replaces the file whole).
 */
export const OUTREACH_HANDLERS = Object.freeze({
  "prepare-draft": "L-DRAFT",
  "put-content": "L-DRAFT",
  "content-checks": "L-DRAFT",
  resources: "L-DRAFT",
  "get-draft": "L-DRAFT",
  "publish-resource": "L-DRAFT",
  authorize: "L-AUTH",
  "prepare-review": "L-AUTH",
  "get-review": "L-AUTH",
  "revoke-authorization": "L-AUTH",
  "withdraw-policy": "L-AUTH",
  send: "L-SEND",
  "sender-identity": "L-SEND",
  "record-activity": "L-ACT",
  "opt-out": "L-ACT",
  "opt-out-admission": "L-ACT",
  metrics: "L-ACT",
  "list-activities": "L-ACT",
  diagnosis: "L-ACT",
  "prospects/record-source": "L-SOURCE",
  "prospects/record-contact": "L-SOURCE",
  "prospects/contact-key": "L-SOURCE",
} as const);
export type OutreachHandlerName = keyof typeof OUTREACH_HANDLERS;

export class OutreachNotBuilt extends Error {
  readonly code = "NOT_BUILT";
  constructor(readonly handler: OutreachHandlerName) {
    super(`NOT_BUILT: the B12 handler ${handler} is lane ${OUTREACH_HANDLERS[handler]}'s and has not landed`);
    this.name = "OutreachNotBuilt";
  }
}

/** The stub of one handler: a function that throws OutreachNotBuilt, never a partial behaviour. */
export function notBuilt(handler: OutreachHandlerName): (...args: never[]) => never {
  return () => {
    throw new OutreachNotBuilt(handler);
  };
}
