// UI10 Agency switcher as markup (Order 24; registry: "Choose the agency you are working with."): only the person's own memberships, as
// ListAgencies answers them — the agency's name (customer text, a text node), the person's role in words, the agency's state only when it is
// not the ordinary one, and one way in for an active membership. The way in is a full document navigation (a plain link), so nothing of
// the agency the page showed before survives the switch. Pure markup: the container owns the read.
import { Button, LinkButton, StatusBadge } from "@kauro/ui";
import type { ReactElement } from "react";
import type { AgencyMembershipView } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";

export interface SwitcherProps {
  readonly memberships: readonly AgencyMembershipView[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onMore: () => void;
  /** The agency the page's runtime belongs to, if any (marked "You are here", never linked). */
  readonly current: string | null;
  /** The workspace's Projects page. */
  readonly openHref: (agencyId: string) => string;
}

export function AgencySwitcher({ memberships, hasMore, loading, onMore, current, openHref }: SwitcherProps): ReactElement {
  if (memberships.length === 0 && !loading) {
    return (
      <section>
        <h2>{message("screen.switcher.empty.title")}</h2>
        <p>{message("screen.switcher.empty.body")}</p>
      </section>
    );
  }
  return (
    <section className="kauro-screen-section" aria-labelledby="switcher-list">
      <h2 id="switcher-list" className="kauro-visually-hidden-text">{message("screen.switcher.list.heading")}</h2>
      <ul className="kauro-ledger-list">
        {memberships.map((m) => {
          const usable = m.membershipState === "ACTIVE" && m.state !== "CLOSED";
          return (
            <li key={m.membershipId} className="kauro-ledger-item">
              <div className="kauro-ledger-item-head">
                <h3>
                  <bdi>{m.displayName}</bdi>
                </h3>
                {m.agencyId === current ? (
                  <StatusBadge tone="info">{message("screen.switcher.current.label")}</StatusBadge>
                ) : usable ? (
                  <LinkButton href={openHref(m.agencyId)} variant="secondary">
                    {message("screen.switcher.open.cta")}
                  </LinkButton>
                ) : null}
              </div>
              <dl className="kauro-ledger-facts">
                <div><dt>{message("screen.switcher.role.label")}</dt><dd>{message(`shell.role.${m.role}.label`)}</dd></div>
                {m.state === "ACTIVE" ? null : (
                  <div><dt>{message("screen.switcher.state.label")}</dt><dd><StatusBadge tone="warning">{message(`shell.agency.state.${m.state}.label`)}</StatusBadge></dd></div>
                )}
                {m.membershipState === "ACTIVE" ? null : (
                  <div><dt>{message("screen.switcher.membership.label")}</dt><dd>{message(`screen.switcher.membership.${m.membershipState}`)}</dd></div>
                )}
              </dl>
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <Button variant="secondary" disabled={loading} onClick={onMore}>
          {message("screen.switcher.more.cta")}
        </Button>
      ) : null}
    </section>
  );
}
