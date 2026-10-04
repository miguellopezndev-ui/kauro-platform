// The English copy catalogue (design D-COPY-1; 11, D54, A3 section 3): the only place product text lives. No i18n framework: one language,
// message ids, numbers formatted en-US. A screen asks for a message by id; a missing id or a missing or extra parameter is a compile or
// run-time failure, never a blank. Every entry is checked by copy-lint.test.ts (A3 rules in lint.ts), so a forbidden phrase cannot land.
//
// Id convention (the lint reads the last segment): `.title`, `.heading`, `.label`, `.cta`, `.offer`, `.subject` and `.name` are surfaces
// where AI never appears (A3 3.1); `.body` and `.hint` are running text.
import type { NextStep, SharedState } from "../client/states.ts";
import { PUBLIC_COPY } from "./public.ts";

/** The application's own entries: the shell, the shared states, their next steps, the guard (W3). */
export const APPLICATION_COPY = {
  // the application shell
  "shell.brand.name": "Kauro",
  "shell.skip-link.label": "Skip to main content",
  "shell.navigation.label": "Agency navigation",
  "shell.agency.label": "Agency",
  "shell.agency.loading.body": "Checking your agency",
  "shell.agency.unavailable.body": "This agency is not available",
  "shell.agency.switch.label": "Switch agency",
  "shell.sign-out.label": "Sign out",
  "shell.session.checking.body": "Checking your session",
  "shell.session.signed-out.title": "You are signed out",
  "shell.session.signed-out.body": "Sign in to continue.",
  "shell.session.leaving.body": "Signing you out",
  "shell.session.switching.body": "Switching agency",
  "shell.session.unavailable.title": "We could not check your session",
  "shell.session.unavailable.body": "Nothing is shown until your session is confirmed. Check again in a moment.",
  "shell.session.check-again.label": "Check again",
  "shell.session.sign-out-failed.title": "We could not confirm that you signed out",
  "shell.session.sign-out-failed.body": "You may still be signed in. Try signing out again.",
  "shell.agency.state.DRAFT.label": "Draft",
  "shell.agency.state.ACTIVE.label": "Active",
  "shell.agency.state.RESTRICTED.label": "Restricted",
  "shell.agency.state.CLOSING.label": "Closing",
  "shell.agency.state.CLOSED.label": "Closed",
  // navigation entries of an agency (one per real screen; an entry appears only when its screen exists)
  "nav.projects.label": "Projects",
  "nav.clients.label": "Clients",
  "nav.team.label": "Team",
  "nav.billing.label": "Billing",
  "nav.settings.label": "Settings",
  "nav.support.label": "Support",
  // unsaved edits (R2-064): four separate facts and the three ways out
  "guard.title": "You have unsaved edits",
  "guard.body": "Your edits are only on this page. Leaving now would lose them.",
  "guard.edits.body": "{count} unsaved edits",
  "guard.stay.label": "Stay",
  "guard.save-draft.label": "Save draft",
  "guard.discard.label": "Discard",
  "status.local-edits.label": "Local edits",
  "status.saved-draft.label": "Saved draft",
  "status.validated.label": "Validated",
  "status.approved.label": "Approved",
  // the 14 shared states of the reference (states.ts decides which one applies; the screen adds its own subject)
  "state.LOADING.title": "Loading",
  "state.LOADING.body": "Fetching the current information. Nothing from the previous page is shown.",
  "state.EMPTY.title": "Nothing here yet",
  "state.EMPTY.body": "Start with the first step below.",
  "state.READY.title": "Ready",
  "state.READY.body": "This is the current information.",
  "state.UNSAVED.title": "Not saved yet",
  "state.UNSAVED.body": "Your edits are only on this page. Nothing has been saved, checked or approved.",
  "state.STALE.title": "This changed while you were working",
  "state.STALE.body": "Compare the current version with yours before anything is sent.",
  "state.DENIED.title": "This is not available",
  "state.DENIED.body": "You cannot open this with your current access.",
  "state.RESTRICTED.title": "This is restricted right now",
  "state.RESTRICTED.body": "New work is blocked here. Support, refunds and deletion stay available.",
  "state.PENDING.title": "We are checking the result",
  "state.PENDING.body": "The action may already be recorded. Do not repeat it: we look up the same operation.",
  "state.UNCERTAIN.title": "We are confirming your payment",
  "state.UNCERTAIN.body": "Do not pay again. We are reconciling the result and will show it here.",
  "state.EXPIRED.title": "This has expired",
  "state.EXPIRED.body": "The review it was based on is no longer current. Request a new review to continue.",
  "state.CANCELLED.title": "This was cancelled",
  "state.CANCELLED.body": "Reload to see what happened and what remains.",
  "state.INTEGRITY_FAILURE.title": "We could not verify this answer",
  "state.INTEGRITY_FAILURE.body": "Nothing was changed on this screen. Share the support reference if you contact support.",
  "state.DELETED.title": "This was deleted",
  "state.DELETED.body": "Only safe history remains. The data and its old links are gone.",
  "state.SUCCESS.title": "Done",
  "state.SUCCESS.body": "The result is recorded.",
  "state.support-reference.body": "Support reference: {reference}",
  "state.retry-after.hint": "Try again in {seconds} seconds.",
  // the one next step a state offers
  "next.SIGN_IN.label": "Sign in",
  "next.STEP_UP.label": "Confirm your identity",
  "next.FIX_FIELDS.label": "Fix the marked fields",
  "next.RELOAD.label": "Reload",
  "next.COMPARE_VERSIONS.label": "Compare versions",
  "next.REQUERY.label": "Check again",
  "next.REQUEST_NEW_REVIEW.label": "Request a new review",
  "next.CHOOSE_ANOTHER_MODE.label": "Choose another service",
  "next.RETRY_LATER.label": "Try again later",
  "next.CONTACT_SUPPORT.label": "Contact support",
  "next.SECURE_UPLOAD.label": "Use the secure upload",
} as const satisfies Readonly<Record<string, string>>;

/**
 * The one catalogue of the web application (D-COPY-1; B11 stage-1 integration, D-W5a-2): the application's own entries and the public
 * site's (copy/public.ts, the names and sentences A3 fixes word for word among them), merged by key prefix: no id is defined by both,
 * so the A3 rules that count a sentence count it once over everything a person can read.
 */
export const EN = { ...APPLICATION_COPY, ...PUBLIC_COPY } as const;

export type MessageId = keyof typeof EN;
export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** The distinct placeholder names of a message text, in order of first appearance. */
export function placeholdersOf(text: string): readonly string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""))];
}

const NUMBER = new Intl.NumberFormat("en-US");

/** The text of a message. Numbers are formatted en-US; the parameters must be exactly the message's placeholders. */
export function message(id: MessageId, params: MessageParams = {}): string {
  const text: string = EN[id];
  const wanted = placeholdersOf(text);
  const given = Object.keys(params);
  const missing = wanted.filter((name) => !Object.hasOwn(params, name));
  const extra = given.filter((name) => !wanted.includes(name));
  if (missing.length > 0 || extra.length > 0) throw new RangeError(`message ${id}: missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]`);
  return text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = params[name];
    return typeof value === "number" ? NUMBER.format(value) : String(value);
  });
}

/** Title and body of a shared state. */
export function stateCopy(state: SharedState): { readonly title: string; readonly body: string } {
  return { title: EN[`state.${state}.title`], body: EN[`state.${state}.body`] };
}

/** The label of a next step, or null for NONE (a state that offers no control). */
export function nextStepLabel(step: NextStep): string | null {
  return step === "NONE" ? null : EN[`next.${step}.label`];
}
