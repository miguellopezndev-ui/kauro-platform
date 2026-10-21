// The index of the owner's private-screen review (Order 11 §6): all 42 private screens of the registry in the five review groups, each with
// its technical state and its review state, one click from its viewer. Any gap between the groups and the registry is shown, not hidden.
import { GROUPS, INVENTORY_GAPS, screenOf, TECHNICAL_LABEL } from "@review/lib/inventory.ts";
import { viewerHref } from "@review/lib/links.ts";
import { PROPOSALS } from "@review/lib/proposals.ts";
import { reviewOf } from "@review/lib/review-status.ts";

export default function Index() {
  const counts = { total: 0, implemented: 0, prototype: 0, blocked: 0 };
  for (const group of GROUPS)
    for (const id of group.ids) {
      const screen = screenOf(id);
      counts.total += 1;
      if (screen?.technical === "IMPLEMENTED") counts.implemented += 1;
      else if (screen?.technical === "BLOCKED_EXTERNAL") counts.blocked += 1;
      else counts.prototype += 1;
    }
  const gaps = INVENTORY_GAPS.missing.length + INVENTORY_GAPS.repeated.length;
  return (
    <main className="rx">
      <h1>Kauro review — private screens</h1>
      <p className="rx-lead">
        Every private screen of the registry ({INVENTORY_GAPS.registryPrivate} of {INVENTORY_GAPS.registryTotal}), drawn on your machine with synthetic data. Nothing is sent or saved; no
        account, provider or CRM is touched. Open a screen, change the person, its state, the width and the theme, and move to the next one.
      </p>
      <section className="rx-experiences" aria-labelledby="rx-walk">
        <h2 id="rx-walk">Walk it as a person</h2>
        <p>The application at its real addresses, as each person lives it. Use the links inside the pages; the strip at the top says who you are and lets you change it.</p>
        <ul>
          <li>
            <a href="/">Public site, up to sign-in</a>
            <span>From the home page to the contact form; its Sign in opens the review's sign-in.</span>
          </li>
          <li>
            <a href="/__as/agency">Agency (Lena Ortiz, owner of Northwind Data)</a>
            <span>Starts at her agencies. Also as a company, an admin or an operator from the strip.</span>
          </li>
          <li>
            <a href="/__as/company">Company buying direct (Halden Outdoor)</a>
            <span>Its own projects, no clients: the direct channel.</span>
          </li>
          <li>
            <a href="/signup?review-as=newcomer">Someone new, from Create an account</a>
            <span>Sign-up, two-step verification, setting up the workspace, then the first project.</span>
          </li>
          <li>
            <a href="/__as/owner">Kauro owner</a>
            <span>The operations area.</span>
          </li>
          <li>
            <a href="/__as/seller">Seller (Daniel Kim)</a>
            <span>The sales area.</span>
          </li>
        </ul>
      </section>
      <section className="rx-experiences" aria-labelledby="rx-variants">
        <h2 id="rx-variants">Public-site proposals</h2>
        <p>Proposals that need a decision before they can join the site (a new page or a change to a contract). Supported services and Pricing were rebuilt on the site itself in round 2.</p>
        <ul>
          <li>
            <a href="/__variants/free-check">Check a file free: the page the main call to action would open</a>
            <span>Then Create an account and the self-serve start (P-05, UI09). Changes A3 §3.2: your decision (F-03).</span>
          </li>
          <li>
            <a href="/__variants/for-agencies">For agencies: a page for the main channel</a>
            <span>Only the statements and limits you set; branded reports shown as not available yet.</span>
          </li>
          <li>
            <a href="/__variants/contact">Contact: the required authorisation and &quot;Email address&quot;</a>
            <span>
              Beside <a href="/contact">the approved page</a>; fixes F-08 on the form. Nothing is sent from the review.
            </span>
          </li>
        </ul>
      </section>
      <p className="rx-counts">
        <strong>{counts.total}</strong> screens · <strong>{counts.implemented}</strong> implemented (real components, review data) · <strong>{counts.prototype}</strong> visual prototypes ·{" "}
        <strong>{counts.blocked}</strong> blocked by an external provider
        {gaps === 0 ? " · registry check: no screen missing or repeated" : ` · registry check: MISSING ${INVENTORY_GAPS.missing.join(", ")} REPEATED ${INVENTORY_GAPS.repeated.join(", ")}`}
      </p>
      <p className="rx-legend">
        <span className="rv-tech rv-tech--IMPLEMENTED">{TECHNICAL_LABEL.IMPLEMENTED}</span> the application&apos;s own page and components, fed by an identified fixture.{" "}
        <span className="rv-tech rv-tech--PROTOTYPE">{TECHNICAL_LABEL.PROTOTYPE}</span> the designed screen, not wired to the api; nothing in it works for real.{" "}
        <span className="rv-tech rv-tech--BLOCKED_EXTERNAL">{TECHNICAL_LABEL.BLOCKED_EXTERNAL}</span> designed, but its real behaviour needs a provider that is not connected.{" "}
        <span className="rv-tech rv-tech--PROPOSED">{TECHNICAL_LABEL.PROPOSED}</span> a design you asked for that needs a new contract before it can be built.
      </p>
      {GROUPS.map((group) => (
        <section key={group.key} className="rx-group" aria-labelledby={`group-${group.key}`}>
          <h2 id={`group-${group.key}`}>
            {group.key}. {group.title}
          </h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Screen</th>
                <th scope="col">Route in the application</th>
                <th scope="col">Technical state</th>
                <th scope="col">Your review</th>
              </tr>
            </thead>
            <tbody>
              {group.ids.map((id) => {
                const screen = screenOf(id);
                if (screen === undefined) return null;
                const review = reviewOf(id);
                return (
                  <tr key={id}>
                    <th scope="row">
                      <a href={viewerHref(id)}>
                        <span className="rv-id">{id}</span> {screen.title}
                      </a>
                      <span className="rx-says">{screen.primaryCopy}</span>
                    </th>
                    <td>
                      <code>{screen.route}</code>
                    </td>
                    <td>
                      <span className={`rv-tech rv-tech--${screen.technical}`}>{TECHNICAL_LABEL[screen.technical]}</span>
                    </td>
                    <td>
                      <span className={`rv-review rv-review--${review}`}>{review.replaceAll("_", " ")}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {PROPOSALS.filter((proposal) => proposal.group === group.key).length === 0 ? null : (
            <div className="rx-proposals">
              <h3>Proposed designs in this group — not in the registry; your visual approval comes before any contract change</h3>
              <ul>
                {PROPOSALS.filter((proposal) => proposal.group === group.key).map((proposal) => (
                  <li key={proposal.key}>
                    <a href={viewerHref(proposal.key)}>
                      <span className="rv-id">{proposal.key}</span> {proposal.title}
                    </a>{" "}
                    — {proposal.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}
    </main>
  );
}
