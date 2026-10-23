"use client";
// The container of UI10 (Order 24; design D-PRIV-1, D-STATE-1): the person's memberships as a paged ListAgencies read. A refused read draws
// the shared state and no agency.
import type { ReactElement } from "react";
import type { AgencyMembershipView, ListAgenciesReply } from "../../api/generated.ts";
import { pathOf } from "../../screens.ts";
import { useShell } from "../../shell/shell-context.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { type PagedSource, usePagedRead } from "../shared/use-paged-read.ts";
import { AgencySwitcher } from "./view.tsx";

const PAGE_SIZE = 50;

export function membershipSource(client: ReturnType<typeof useShell>["client"]): PagedSource<ListAgenciesReply, AgencyMembershipView> {
  return {
    load: (cursor, signal) => client.call("ListAgencies", { query: cursor === null ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor }, signal }),
    pageOf: (body) => ({ items: body.data.items, nextCursor: body.data.nextCursor ?? null, version: "agencies" }),
  };
}

export function SwitcherScreen(): ReactElement {
  const shell = useShell();
  const paged = usePagedRead(membershipSource(shell.client), "agencies");
  if (paged.state.status === "FAILED" && paged.state.failure !== null) return <StatePanel decision={paged.state.failure} onNext={paged.reload} />;
  return (
    <AgencySwitcher
      memberships={paged.state.items}
      hasMore={paged.state.hasMore}
      loading={paged.state.status === "LOADING" || paged.state.status === "IDLE"}
      onMore={paged.more}
      current={shell.session.activeAgency()}
      openHref={(agencyId) => pathOf("UI11", { agencyId })}
    />
  );
}
