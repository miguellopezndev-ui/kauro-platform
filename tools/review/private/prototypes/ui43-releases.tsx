"use client";
// UI43 Releases (registry: "Promote only the accepted exact candidate."). One candidate, identified completely: the commit, the source tree,
// the packages, the image digest and the contract versions, with the evidence for that exact identity (each gate and where it ran) and the
// business readiness the owner answers for. A run that only shares a name, or an image rebuilt from the same commit, cannot borrow an
// acceptance (registry exception): the page shows the mismatch and holds the promotion. Promoting is the owner's decision, never automatic.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead } from "./kit.tsx";

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
    <>
      <PageHead title="Releases" lead="Promote only the accepted exact candidate." />
      {rebuilt ? (
        <Banner tone="danger" title="This image is not the one that was tested" announce="alert">
          <p>The image was rebuilt at 3:02 PM UTC from the same commit. Its digest is new, so the gates that passed at 2:10 PM UTC do not apply to it. Promotion is held until the gates run on this exact image.</p>
        </Banner>
      ) : null}
      <section className="kauro-prospect" aria-labelledby="cand-h">
        <div className="kauro-prospect-head">
          <h2 id="cand-h">Candidate 2026.10.3</h2>
          <Badge tone={rebuilt ? "danger" : "success"}>{rebuilt ? "Held" : "Accepted"}</Badge>
        </div>
        <dl className="kauro-prospect-facts kauro-release-ids">
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
              {rebuilt ? <span className="kauro-statement-hold">Tested image: sha256 7c03aa19…</span> : null}
            </dd>
          </div>
        </dl>
      </section>
      <div className="kauro-table-region">
        <table className="kauro-table">
          <caption className="kauro-visually-hidden">The evidence for this exact candidate</caption>
          <thead>
            <tr>
              <th scope="col">Gate</th>
              <th scope="col">Result for image {rebuilt ? "e81f5d20" : "7c03aa19"}</th>
            </tr>
          </thead>
          <tbody>
            {gates.map(([gate, result]) => (
              <tr key={gate}>
                <th scope="row">{gate}</th>
                <td>{rebuilt ? "Not run on this image" : result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="kauro-screen-section" aria-labelledby="biz-h">
        <h2 id="biz-h">Business readiness</h2>
        <ul>
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
        <section className="kauro-approve" aria-labelledby="prom-h">
          <h2 id="prom-h">Promote</h2>
          <p>Promotes exactly image 7c03aa19 to production. Nothing else is deployed, and the current release stays ready to restore.</p>
          <div className="kauro-actions">
            <Button variant="primary">Promote 2026.10.3</Button>
            <Button>Restrict a capability first</Button>
          </div>
        </section>
      )}
    </>
  );
}
