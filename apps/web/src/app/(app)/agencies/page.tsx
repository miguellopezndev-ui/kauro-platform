import { message } from "../../../copy/en.ts";
import { PageHeader } from "../../../screens/shared/project-header.tsx";
import { SwitcherScreen } from "../../../screens/switcher/container.tsx";

// UI10 Agency switcher (Order 24; design D-ROUTE-1): the person's own memberships, read by the browser from ListAgencies.
export default function Page() {
  return (
    <>
      <PageHeader title={message("screen.switcher.title")} lead={message("screen.switcher.lead.body")} />
      <SwitcherScreen />
    </>
  );
}
