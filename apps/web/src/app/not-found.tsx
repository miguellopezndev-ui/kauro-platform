// The not-found document of every route: plain text and semantics, no inline style attribute (the policy forbids them,
// D-SEC-1), no statement about whether any resource exists (08: foreign and nonexistent resources look the same). It names no link:
// the same document answers on the public, application and ops hosts, and a link that is right on one host is a 404 on another.
//
// The page answers in the product's own terms: the heading and its sentence are the result of a lookup that matched no row, set on one
// card of the product, tilted like a sheet left on a desk and stamped. The figure and the empty rows are a picture, hidden from assistive
// technology; the heading and the sentence are the message.
export default function NotFound() {
  return (
    <main className="kauro-notfound">
      <p className="kauro-notfound-brand">Kauro</p>
      <div className="kauro-notfound-card">
        <div className="kauro-notfound-bar" aria-hidden="true">
          <span className="kauro-notfound-bar-title">Lookup</span>
          <span className="kauro-notfound-bar-state">No match</span>
        </div>
        <div className="kauro-notfound-body">
          <p className="kauro-notfound-figure" aria-hidden="true">
            <span className="kauro-notfound-zero">0</span>
            <span className="kauro-notfound-unit">rows matched this address</span>
          </p>
          <h1>Page not found</h1>
          <p className="kauro-notfound-text">This page does not exist or is not available to you.</p>
          <div className="kauro-notfound-rows" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
        <span className="kauro-notfound-stamp" aria-hidden="true">
          Not found
        </span>
      </div>
    </main>
  );
}
