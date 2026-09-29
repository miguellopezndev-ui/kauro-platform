// The not-found document of every route: plain text and semantics, no inline style attribute (the policy forbids them,
// D-SEC-1), no statement about whether any resource exists (08: foreign and nonexistent resources look the same).
export default function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <p>This page does not exist or is not available to you.</p>
    </main>
  );
}
