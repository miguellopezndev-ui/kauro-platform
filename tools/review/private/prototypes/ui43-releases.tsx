"use client";
// UI43 Releases (registry: "Promote only the accepted exact candidate."). Round 2: the lead says the decision in plain words; a candidate
// waiting for promotion also appears in Today's queue. One candidate, identified completely (commit, source tree, packages, image digest),
// with the evidence for that exact identity and the business readiness the owner answers for. A run that only shares a name, or an image
// rebuilt from the same commit, cannot borrow an acceptance (registry exception): the page shows the mismatch and holds the promotion.
// Promoting is the owner's decision, never automatic. Times in UTC: this is a technical page.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";

export const UI43_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to promote", note: "Candidate 2026.10.3: every gate passed on this exact identity; waiting for the owner." },
  { key: "rebuilt", label: "A rebuilt image", note: "The image was rebuilt after the gates ran: its digest differs, so the acceptance does not carry over." },
];

export function Releases({ state }: PrototypeProps): ReactElement {
  const rebuilt = state === "rebuilt";
  const gates = [
    ["Tests, Ubuntu", "Passed · run 4812"],
    ["Tests, Windows", "Passed · run 4813"],
    ["Architecture gate", "Passed"],
    ["Contracts unchanged since 2026.10.2", "Yes · registry 41, OpenAPI 1.14.0"],
    ["Accessibility (axe, 5 widths, 2 themes)", "No violation"],
  ] as const;
  return (
    <OpsPage>
      <OpsHead title="Releases" lead={rebuilt ? "Candidate 2026.10.3 is held: its image is not the one that was tested." : "Candidate 2026.10.3 passed every gate on its exact image and waits for your promotion."} />
      {rebuilt ? (
        <Banner tone="danger" title="This image is not the one that was tested" announce="alert">
          <p>The image was rebuilt at 3:02 PM UTC from the same commit. Its digest is new, so the gates that passed at 2:10 PM UTC do not apply to it. Promotion is held until the gates run on this exact image.</p>
        </Banner>
      ) : null}
      <section aria-labelledby="cand-h">
        <SectionHead id="cand-h" title="Candidate 2026.10.3" aside={<Word tone={rebuilt ? "danger" : "success"}>{rebuilt ? "Held" : "Accepted"}</Word>} />
        <dl className="kauro-ops-facts">
          <div>
            <dt>Commit</dt>
            <dd>
              <code>c4e1d2a9</code> on main
            </dd>
          </div>
          <div>
            <dt>Source tree</dt>
            <dd>
              <code>tree 9d2c41e7…</code>
            </dd>
          </div>
          <div>
            <dt>Packages</dt>
            <dd>
              <code>lock 51ab07c3…</code>
            </dd>
          </div>
          <div>
            <dt>Image</dt>
            <dd>
              <code>sha256 {rebuilt ? "e81f5d20…" : "7c03aa19…"}</code>
              {rebuilt ? <span className="kauro-ops-sub">Tested image: sha256 7c03aa19…</span> : null}
            </dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="gates-h">
        <SectionHead id="gates-h" title="Evidence" meta={`For image ${rebuilt ? "e81f5d20" : "7c03aa19"} only`} />
        <div className="kauro-ops-tablewrap">
          <div className="kauro-table-region">
            <table className="kauro-table kauro-ops-table kauro-ops-table--cards kauro-ops-table--compact">
              <caption className="kauro-visually-hidden">The evidence for this exact candidate</caption>
              <thead>
                <tr>
                  <th scope="col">Gate</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {gates.map(([gate, result]) => (
                  <tr key={gate}>
                    <th scope="row">{gate}</th>
                    <td data-label="Result">
                      <span>{rebuilt ? "Not run on this image" : result}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section aria-labelledby="biz-h">
        <SectionHead id="biz-h" title="Business readiness" />
        <ul className="kauro-ops-lines">
          <li>Legal texts: unchanged; no new version to publish.</li>
          <li>Prices and policy: R2-INITIAL, unchanged.</li>
          <li>Support: the help pages that change are ready, reviewed on Oct 19, 2026.</li>
        </ul>
      </section>
      {rebuilt ? (
        <div className="kauro-actions">
          <Button variant="primary">Run the gates on this image</Button>
          <Button>Open a repair</Button>
        </div>
      ) : (
        <section className="kauro-ops-decide" aria-labelledby="prom-h">
          <h2 id="prom-h">Promote 2026.10.3</h2>
          <p>Promotes exactly image 7c03aa19 to production. Nothing else is deployed, and the current release stays ready to restore.</p>
          <div className="kauro-actions">
            <Button variant="primary">Promote 2026.10.3</Button>
            <Button>Restrict a capability first</Button>
          </div>
        </section>
      )}
    </OpsPage>
  );
}
