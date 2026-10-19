# Order 10: the owner's interactive review of the public web

**Environment:** the real candidate build, served on the owner's machine only by `tools/review/serve.mjs`.
- Address: `http://127.0.0.1:4400`; the index is `/__review`.
- The tool is outside the product build (`apps/web/test/review-isolation.test.ts`).

**Categories:**
- **IMPLEMENTED:** real route and components.
- **IMPLEMENTED WITH SYNTHETIC DATA:** real components fed by an identified fixture. This proves nothing about the production backend.
- **PROTOTYPE NOT IMPLEMENTED:** a visual proposal for a function not built. There are none on the public web.

**Decisions before the review (2026-10-19):**
- The web keeps its previous system families. Inter stays for printed documents only (A10 §11).
- The narrow-screen corrections of Order 10 are kept and were re-checked with the system families.

Each observation is recorded here as the owner makes it, with its correction and the owner's acceptance after seeing the result in the
environment. A page is approved only when the owner says so, not because tests pass.

| # | Page | Width / theme | Observation (owner) | Correction | Commit | Owner's verdict |
| --- | --- | --- | --- | --- | --- | --- |
