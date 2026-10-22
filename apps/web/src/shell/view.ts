// What the application shell draws (design D-PRIV-1, D-STATE-1, D-A11Y-1; 11 "Every navigation link resolves to real content or an
// explicitly unavailable feature"). A pure function of the session phase, the agency context and the pathname; the components only render
// what it answers, so every rule below is a test over data.
//   - A private screen's content (the "gate") is drawn only while the session is confirmed and, inside an agency, the agency is confirmed
//     for the agency the URL names. Everything else is a message: waiting is a polite status, a refusal is a heading with the one next step.
//   - An anonymous screen (the sign-in, the invitation, the public pages) is never held back by the session and carries no private chrome.
//   - The agency name, the navigation and the sign-out control exist only while the session is confirmed.
//   - The navigation lists a screen only when its page exists in this build; an agency with no implemented entry has no navigation.
import type { SessionPhase } from "../client/session.ts";
import type { MessageId } from "../copy/en.ts";
import { agencyOfPathname, IMPLEMENTED_SCREENS, matchRoute, navigationFor, opsNavigationFor, originOfPath, pathOf, projectAreasFor, projectOfPathname, type ServiceMode, signInHref } from "../screens.ts";
import type { AgencyContext, AgencyState } from "./agency-context.ts";

export type RefusedAction = { readonly kind: "SIGN_IN"; readonly href: string } | { readonly kind: "CHECK_AGAIN" } | { readonly kind: "SIGN_OUT" } | { readonly kind: "NONE" };

export type Gate =
  | { readonly kind: "OPEN" }
  | { readonly kind: "WAIT"; readonly message: MessageId }
  | { readonly kind: "REFUSED"; readonly title: MessageId; readonly body: MessageId; readonly action: RefusedAction };

export interface NavigationItem {
  readonly screen: string;
  readonly label: MessageId;
  readonly href: string;
  readonly current: boolean;
  /** The heading it sits under (none: the first group; "nav.group.help.label": the foot of the menu). */
  readonly group?: MessageId;
}

/** The project a page is inside, as the menu nests it under Projects and the project's header names it. */
export interface ProjectInView {
  readonly name: string;
  readonly clientLabel: string;
  readonly mode: ServiceMode;
  readonly areas: readonly { readonly key: string; readonly label: MessageId; readonly href: string; readonly current: boolean; readonly apart: boolean }[];
}

export interface ShellView {
  readonly gate: Gate;
  /** The agency indicator: its name (a customer string, drawn as a text node) and the message id of its state. */
  readonly agency: { readonly name: string; readonly state: MessageId; readonly role?: MessageId | null } | null;
  readonly navigation: readonly NavigationItem[];
  /** The agency switcher, when its screen exists. */
  readonly switchHref: string | null;
  readonly signOut: boolean;
  /** True on the operations origin: the menu is Kauro's own, with no workspace in it. */
  readonly ops: boolean;
  /** The person's own settings, when that screen exists (none in this build). */
  readonly accountHref: string | null;
  /** True on a screen without a person (sign-in, invitation): a plain header, never the private menu. */
  readonly anonymous?: boolean;
  /** The project the page is inside, with its areas for its service (Order 11); null outside a project or before the project is read. */
  readonly project?: ProjectInView | null;
}

export interface ShellInput {
  readonly phase: SessionPhase;
  readonly agency: AgencyContext;
  readonly pathname: string;
  /** The agency of the page's URL when it was loaded: the agency this page's runtime belongs to for its whole life. */
  readonly activeAgency: string | null;
  readonly implemented?: ReadonlySet<string>;
  /** The operations screens this person may open, as their capabilities say; absent, every implemented entry is listed. */
  readonly allowedOps?: ReadonlySet<string>;
  /** The project of the page, once read: its name, its client and its service. Absent, the menu does not nest a project. */
  readonly project?: { readonly projectId: string; readonly name: string; readonly clientLabel: string; readonly mode: ServiceMode };
}

const stateLabel = (state: AgencyState): MessageId => `shell.agency.state.${state}.label`;

const CLOSED_SHELL: Pick<ShellView, "agency" | "navigation" | "switchHref" | "signOut" | "ops" | "accountHref"> = { agency: null, navigation: [], switchHref: null, signOut: false, ops: false, accountHref: null };

function refused(title: MessageId, body: MessageId, action: RefusedAction): Gate {
  return { kind: "REFUSED", title, body, action };
}

export function viewOf(input: ShellInput): ShellView {
  const implemented = input.implemented ?? IMPLEMENTED_SCREENS;
  if (matchRoute(input.pathname)?.screen.anonymous === true) return { gate: { kind: "OPEN" }, ...CLOSED_SHELL, anonymous: true };
  const { phase } = input;
  switch (phase.kind) {
    case "CHECKING":
      return { gate: { kind: "WAIT", message: "shell.session.checking.body" }, ...CLOSED_SHELL };
    case "LEAVING":
      return { gate: { kind: "WAIT", message: "shell.session.leaving.body" }, ...CLOSED_SHELL };
    case "SWITCHING":
      return { gate: { kind: "WAIT", message: "shell.session.switching.body" }, ...CLOSED_SHELL };
    case "SIGNED_OUT":
      return { gate: refused("shell.session.signed-out.title", "shell.session.signed-out.body", { kind: "SIGN_IN", href: signInHref(input.pathname) }), ...CLOSED_SHELL };
    case "UNAVAILABLE":
      return {
        gate:
          phase.reason === "SIGN_OUT_UNCONFIRMED"
            ? refused("shell.session.sign-out-failed.title", "shell.session.sign-out-failed.body", { kind: "SIGN_OUT" })
            : refused("shell.session.unavailable.title", "shell.session.unavailable.body", { kind: "CHECK_AGAIN" }),
        ...CLOSED_SHELL,
      };
    case "SIGNED_IN":
      return signedIn(input, implemented);
  }
}

function signedIn(input: ShellInput, implemented: ReadonlySet<string>): ShellView {
  // the agency switcher is a screen of the application origin: an operations page (the owner, a seller) has no agency to switch (Order 11 D-03)
  const ops = originOfPath(input.pathname) === "OPS" || input.pathname === "/ops" || input.pathname.startsWith("/ops/");
  // Order 11 (D-06): no way to the switcher from the switcher itself or from the setup, where there is nothing to switch from
  const switchHref = implemented.has("UI10") && !ops && input.pathname !== pathOf("UI10") && input.pathname !== pathOf("UI09") ? pathOf("UI10") : null;
  const current = (entry: { readonly href: string }): boolean => input.pathname === entry.href || input.pathname.startsWith(`${entry.href}/`);
  if (ops) {
    // the home's entry ("/ops") is current only on itself, never on every operations page under it
    const navigation = opsNavigationFor(implemented, input.allowedOps).map((entry) => ({ ...entry, current: entry.href === "/ops" ? input.pathname === "/ops" : current(entry) }));
    return { gate: { kind: "OPEN" }, agency: null, navigation, switchHref: null, signOut: true, ops: true, accountHref: null };
  }
  const withPerson = { agency: null, navigation: [], switchHref, signOut: true, ops: false, accountHref: null } as const;
  // a client-side navigation that crossed into another agency (or out of one) is never drawn: the page waits for the hard navigation
  if (agencyOfPathname(input.pathname) !== input.activeAgency) return { gate: { kind: "WAIT", message: "shell.session.switching.body" }, ...withPerson };
  if (input.activeAgency === null) {
    // a tenant screen whose agency segment is not an agency id has no agency to show: it is not available, and asking again cannot change it
    const tenant = matchRoute(input.pathname)?.screen.tenant === true;
    return { gate: tenant ? refused("state.DENIED.title", "shell.agency.unavailable.body", { kind: "NONE" }) : { kind: "OPEN" }, ...withPerson };
  }
  switch (input.agency.kind) {
    case "NONE":
    case "LOADING":
      return { gate: { kind: "WAIT", message: "shell.agency.loading.body" }, ...withPerson };
    case "UNAVAILABLE":
      return { gate: refused("state.DENIED.title", "shell.agency.unavailable.body", { kind: "CHECK_AGAIN" }), ...withPerson };
    case "READY": {
      const navigation = navigationFor(input.activeAgency, implemented).map((entry) => ({ ...entry, current: current(entry) }));
      // inside a project the menu nests the project's areas under Projects; the project must be the one the URL names
      const inside = projectOfPathname(input.pathname);
      const project =
        inside !== null && input.project !== undefined && input.project.projectId === inside.projectId
          ? { name: input.project.name, clientLabel: input.project.clientLabel, mode: input.project.mode, areas: projectAreasFor(input.pathname, input.project.mode, implemented) }
          : null;
      const role = input.agency.role === null ? null : (`shell.role.${input.agency.role}.label` as const);
      return { gate: { kind: "OPEN" }, agency: { name: input.agency.displayName, state: stateLabel(input.agency.state), role }, navigation, switchHref, signOut: true, ops: false, accountHref: null, project };
    }
  }
}
