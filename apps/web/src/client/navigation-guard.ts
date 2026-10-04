// NavigationGuard (design D-OPS-3; case R2-064: "Show saved/draft status and a recoverable warning; do not silently treat unsaved local
// edits as approved"). Four facts, four separate statuses:
//   local edits   the fields the person changed in this page and has not saved — the only status computed here, from the edits alone;
//   saved draft   the revision the server holds (CMD023), from a server read or a saved-draft answer;
//   validated     read from the server;   approved   read from the server.
// A status the server owns never changes because of a local edit, and a local edit is never presented as any of the three. Edits live in
// memory only: no autosave, no browser storage (D-PRIV-1). Leaving with edits — an in-app link, the back button, closing the tab — needs an
// answer: Stay, Save draft or Discard. A browser tab close can only be stayed or accepted (the browser owns that prompt), so it offers Stay
// and Discard; Save draft is refused there (design record D-W3-3).

export type Fact = "UNKNOWN" | "YES" | "NO";
export type DraftStatus = { readonly kind: "UNKNOWN" } | { readonly kind: "NONE" } | { readonly kind: "SAVED"; readonly revision: number };

export interface PlanStatuses {
  readonly localEdits: number;
  readonly savedDraft: DraftStatus;
  readonly validated: Fact;
  readonly approved: Fact;
}

/** What one server read of the subject says (the plan just read by the page). */
export interface ServerPlanFacts {
  /** The CMD023 revision of the saved draft, or null when the server holds none. */
  readonly draftRevision: number | null;
  readonly validated: boolean;
  readonly approved: boolean;
}

export type LeaveVia = "IN_APP" | "BACK" | "TAB_CLOSE";
export type LeaveChoice = "STAY" | "SAVE_DRAFT" | "DISCARD";

export type LeaveRequest =
  | { readonly kind: "PROCEED" }
  | { readonly kind: "PROMPT"; readonly via: LeaveVia; readonly options: readonly LeaveChoice[]; readonly localEdits: number };

export type SaveDraftResult =
  | { readonly kind: "SAVED"; readonly revision: number; readonly validated: boolean; readonly approved: boolean }
  | { readonly kind: "REFUSED"; readonly code: string; readonly correlationId: string }
  | { readonly kind: "NO_ANSWER" };

/** Saves the given edits as one draft revision (CMD023) and reports what the server now holds. */
export type DraftSaver = (edits: Readonly<Record<string, unknown>>) => Promise<SaveDraftResult>;

export type ResolveOutcome =
  | { readonly kind: "STAYED" }
  | { readonly kind: "SAVED"; readonly revision: number }
  | { readonly kind: "SAVE_FAILED"; readonly code: string; readonly correlationId: string | null }
  | { readonly kind: "DISCARDED"; readonly discarded: number };

export interface GuardEdit {
  readonly field: string;
  readonly value: unknown;
  /** What the server holds for the field: an edit that puts the field back to it is no longer an unsaved edit. */
  readonly baseline: unknown;
}

const OPTIONS: Readonly<Record<LeaveVia, readonly LeaveChoice[]>> = {
  IN_APP: ["STAY", "SAVE_DRAFT", "DISCARD"],
  BACK: ["STAY", "SAVE_DRAFT", "DISCARD"],
  TAB_CLOSE: ["STAY", "DISCARD"],
};

export class NavigationGuard {
  readonly #saveDraft: DraftSaver;
  readonly #edits = new Map<string, unknown>();
  #savedDraft: DraftStatus = { kind: "UNKNOWN" };
  #validated: Fact = "UNKNOWN";
  #approved: Fact = "UNKNOWN";
  #open: LeaveVia | null = null;

  constructor(deps: { readonly saveDraft: DraftSaver }) {
    this.#saveDraft = deps.saveDraft;
  }

  status(): PlanStatuses {
    return { localEdits: this.#edits.size, savedDraft: this.#savedDraft, validated: this.#validated, approved: this.#approved };
  }

  /** The one place the three server statuses are set from a read of the subject. Local edits are untouched. */
  applyServerRead(facts: ServerPlanFacts): void {
    this.#savedDraft = facts.draftRevision === null ? { kind: "NONE" } : { kind: "SAVED", revision: facts.draftRevision };
    this.#validated = facts.validated ? "YES" : "NO";
    this.#approved = facts.approved ? "YES" : "NO";
  }

  edit(change: GuardEdit): void {
    if (Object.is(change.value, change.baseline)) this.#edits.delete(change.field);
    else this.#edits.set(change.field, change.value);
  }

  /** Asks to leave the page. With nothing typed the answer is PROCEED; otherwise the person is asked and `resolve` answers the question. */
  requestLeave(via: LeaveVia): LeaveRequest {
    if (this.#edits.size === 0) {
      this.#open = null;
      return { kind: "PROCEED" };
    }
    this.#open = via;
    return { kind: "PROMPT", via, options: OPTIONS[via], localEdits: this.#edits.size };
  }

  /** Whether leaving now would lose typed edits (the tab-close listener asks this). */
  hasLocalEdits(): boolean {
    return this.#edits.size > 0;
  }

  async resolve(choice: LeaveChoice): Promise<ResolveOutcome> {
    const via = this.#open;
    if (via === null) throw new RangeError("there is no open question to answer");
    if (!OPTIONS[via].includes(choice)) throw new RangeError(`${choice} is not offered when leaving by ${via}`);
    if (choice === "STAY") {
      this.#open = null;
      return { kind: "STAYED" };
    }
    if (choice === "DISCARD") {
      const discarded = this.#edits.size;
      this.#edits.clear();
      this.#open = null;
      return { kind: "DISCARDED", discarded };
    }
    const sent = new Map(this.#edits);
    const result = await this.#saveDraft(Object.fromEntries(sent));
    if (result.kind !== "SAVED") {
      return result.kind === "REFUSED"
        ? { kind: "SAVE_FAILED", code: result.code, correlationId: result.correlationId }
        : { kind: "SAVE_FAILED", code: "NO_ANSWER", correlationId: null };
    }
    // only the edits the server received are now in the draft: an edit made while the save was in flight stays local
    for (const [field, value] of sent) if (this.#edits.has(field) && Object.is(this.#edits.get(field), value)) this.#edits.delete(field);
    this.#savedDraft = { kind: "SAVED", revision: result.revision };
    this.#validated = result.validated ? "YES" : "NO";
    this.#approved = result.approved ? "YES" : "NO";
    this.#open = null;
    return { kind: "SAVED", revision: result.revision };
  }
}

/** Arms the browser's own leave warning while edits exist; returns the function that disarms it. */
export function armTabClose(guard: NavigationGuard, target: Pick<EventTarget, "addEventListener" | "removeEventListener">): () => void {
  const listener = (event: Event): void => {
    if (!guard.hasLocalEdits()) return;
    event.preventDefault();
    (event as { returnValue?: unknown }).returnValue = "";
  };
  target.addEventListener("beforeunload", listener);
  return () => target.removeEventListener("beforeunload", listener);
}
