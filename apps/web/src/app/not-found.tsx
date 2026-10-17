// The not-found document of every route: plain text and semantics, no inline style attribute (the policy forbids them,
// D-SEC-1), no statement about whether any resource exists (08: foreign and nonexistent resources look the same). It names no link:
// the same document answers on the public, application and ops hosts, and a link that is right on one host is a 404 on another.
//
// The page answers in the product's own terms: a lookup that matched no row. The little result pane repeats the heading's message as a
// picture and is hidden from assistive technology.
export default function NotFound() {
  return (
    <main className="kauro-notfound">
      <p className="kauro-notfound-brand">Kauro</p>
      <div className="kauro-notfound-grid">
        <div className="kauro-notfound-text">
          <h1>Page not found</h1>
          <p>This page does not exist or is not available to you.</p>
        </div>
        <div className="kauro-notfound-pane" aria-hidden="true">
          <span className="kauro-notfound-pane-bar">
            <span className="kauro-notfound-pane-title">Lookup</span>
            <span className="kauro-notfound-pane-state">No match</span>
          </span>
          <span className="kauro-notfound-pane-figure">0</span>
          <span className="kauro-notfound-pane-label">rows matched this address</span>
          <span className="kauro-notfound-pane-rows">
            <span />
            <span />
            <span />
          </span>
          <span className="kauro-notfound-stamp">Not found</span>
        </div>
      </div>
    </main>
  );
}
