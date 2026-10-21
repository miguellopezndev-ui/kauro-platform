// Round 2 (research app-shell-settings.md section 9.10): this is the General page of "Workspace settings", and its scope is said under the
// heading ("These settings apply to everyone in {workspace}"), the question every settings page raises first. Billing identity lives in
// Billing; the agreements are read here. Closing the workspace is last, owner only.
//
// UI32 Settings as markup. Four separate sections: the display label (read-only here), the legal identity (what was accepted), security and
// branding, and the closure, which is its own form with its own button. Customer strings are text nodes.
import { Banner, Button, Deadline, Money, StatusBadge } from "@kauro/ui";
import type { ReactElement } from "react";
import type { AgencyClosureView, AgencyView } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import { settingsModel } from "./model.ts";

/** An agreement's recorded version as people read it: "TERMS_2026_10" is "Version 2026-10"; anything else is shown as recorded. */
export function versionLabel(recorded: string): string {
  const found = /^[A-Z]+_(\d{4})_(\d{2})$/.exec(recorded);
  return found === null ? recorded : message("screen.settings.legal.version", { version: `${found[1]}-${found[2]}` });
}

export interface SettingsViewProps {
  readonly agency: AgencyView;
  readonly onClose: () => void;
  readonly closing: boolean;
  /** What the server answered to the closure request, when it did. */
  readonly closure: AgencyClosureView | null;
}

function Closure({ closure }: { readonly closure: AgencyClosureView }): ReactElement {
  const o = closure.obligations;
  return (
    <section aria-labelledby="settings-closure-done" role="status">
      <h3 id="settings-closure-done">{message("screen.settings.closure.done.heading")}</h3>
      <dl>
        <div><dt>{message("screen.settings.closure.done.requested.label")}</dt><dd><Deadline at={closure.requestedAt} timeZone="UTC" /></dd></div>
        {closure.deletionScheduledFor === undefined ? null : <div><dt>{message("screen.settings.closure.done.deletion.label")}</dt><dd><Deadline at={closure.deletionScheduledFor} timeZone="UTC" /></dd></div>}
        <div><dt>{message("screen.settings.closure.done.quotes.label")}</dt><dd>{o.openQuotesWithdrawn}</dd></div>
        <div><dt>{message("screen.settings.closure.done.authorizations.label")}</dt><dd>{o.liveAuthorizations}</dd></div>
        <div><dt>{message("screen.settings.closure.done.refunds.label")}</dt><dd>{o.openRefunds}</dd></div>
        <div><dt>{message("screen.settings.closure.done.documents.label")}</dt><dd>{o.nonTerminalTaxDocuments}</dd></div>
        <div><dt>{message("screen.settings.closure.done.cases.label")}</dt><dd>{o.openReconciliationCases}</dd></div>
        <div><dt>{message("screen.settings.closure.done.work.label")}</dt><dd>{o.activeWorkItems}</dd></div>
        <div><dt>{message("screen.settings.closure.done.reconciliation.label")}</dt><dd><Money minor={o.openReconciliationCents} currency="USD" /></dd></div>
      </dl>
    </section>
  );
}

export function SettingsDetails({ agency, onClose, closing, closure }: SettingsViewProps): ReactElement {
  const model = settingsModel(agency);
  return (
    <div className="kauro-settings">
      <p className="kauro-settings-scope">
        {message("screen.settings.scope.body", { workspace: agency.displayName })}
      </p>
      <section aria-labelledby="settings-display">
        <h2 id="settings-display">{message("screen.settings.display.heading")}</h2>
        <dl>
          <div><dt>{message("screen.settings.display.label")}</dt><dd>{agency.displayName}</dd></div>
          <div><dt>{message("screen.settings.state.label")}</dt><dd><StatusBadge tone={model.closing ? "warning" : "success"}>{message(`screen.settings.state.${agency.state}`)}</StatusBadge></dd></div>
        </dl>
        <p>{message("screen.settings.display.hint")}</p>
        <p>{message("screen.settings.display.readonly.body")}</p>
      </section>
      <section aria-labelledby="settings-legal">
        <h2 id="settings-legal">{message("screen.settings.legal.heading")}</h2>
        <dl>
          <div><dt>{message("screen.settings.legal.terms.label")}</dt><dd>{agency.termsVersion === undefined || agency.termsVersion === null ? message("screen.settings.legal.none.body") : versionLabel(agency.termsVersion)}</dd></div>
          <div><dt>{message("screen.settings.legal.privacy.label")}</dt><dd>{agency.privacyAgreementVersion === undefined || agency.privacyAgreementVersion === null ? message("screen.settings.legal.none.body") : versionLabel(agency.privacyAgreementVersion)}</dd></div>
        </dl>
        <p>{message("screen.settings.legal.hint")}</p>
      </section>
      <section aria-labelledby="settings-security">
        <h2 id="settings-security">{message("screen.settings.security.heading")}</h2>
        <p>{message("screen.settings.security.body")}</p>
      </section>
      <section aria-labelledby="settings-branding">
        <h2 id="settings-branding">{message("screen.settings.branding.heading")}</h2>
        <p>{message("screen.settings.branding.body")}</p>
      </section>
      <section aria-labelledby="settings-closure" data-section="closure">
        <h2 id="settings-closure">{message("screen.settings.closure.heading")}</h2>
        <p>{message("screen.settings.closure.lead.body")}</p>
        <h3>{message("screen.settings.closure.obligations.heading")}</h3>
        <ul>
          <li>{message("screen.settings.closure.obligations.quotes")}</li>
          <li>{message("screen.settings.closure.obligations.authorizations")}</li>
          <li>{message("screen.settings.closure.obligations.open")}</li>
          <li>{message("screen.settings.closure.obligations.deletion")}</li>
        </ul>
        {model.closing ? (
          <Banner tone="info" announce="status">
            <p>{message("screen.settings.closure.closing.body")}</p>
          </Banner>
        ) : model.mustAskOwner ? (
          <p>{message("screen.settings.closure.owner.body")}</p>
        ) : (
          <Button variant="danger" disabled={closing} aria-busy={closing ? true : undefined} onClick={() => (closing ? undefined : onClose())}>
            {message("screen.settings.closure.cta")}
          </Button>
        )}
        {closing ? <p role="status">{message("screen.settings.closure.working.body")}</p> : null}
        {closure === null ? null : <Closure closure={closure} />}
      </section>
    </div>
  );
}
