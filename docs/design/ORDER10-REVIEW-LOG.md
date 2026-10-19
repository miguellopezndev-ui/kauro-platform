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
| 1 | Legal pages (Not published) | all, both | The card sits above the middle of the page; centre it as the not-found card is (the 404 is already right). | `.kauro-legal-main` centres its card vertically between the brand and the footer (`legal/response.ts`); measured centre 445 px against 450 px at 1280×900, as the 404 (448). | (this commit) | pending the owner's look |
| 2 | Every page | all, light | Too much contrast between the near-white and the black in the light theme; the agreed colour is carbon (the dark theme is right). | The dark already measured carbon `#242426`; the extreme was pure white `#FFFFFF`, which is not in the palette. Raised surfaces (cards, documents, the product window) are now a warm porcelain white `#FAF8F5` (token `raised`, and `.kauro-paper`); no element of the light theme is pure white. | (this commit) | pending the owner's look |
| 3 | How it works and every other page | desktop and phone | Only Home and the first section of How it works move; the other pages lack what Home has. | Each page's first object settles on load as the hero window does: the price ladder, the service cards, the status panel, the data-handling index, the help index, the contact aside, the unsubscribe card. Objects further down settle as they are reached: the sample sheet and its sum, the tables, the scope columns, the counted units. Every card straightens and lifts under the pointer. Reduced motion moves nothing; text never moves on its own. | (this commit) | pending the owner's look |
