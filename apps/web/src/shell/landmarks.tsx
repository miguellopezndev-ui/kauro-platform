// The two landmarks every frame shares (design D-A11Y-1): the skip link and the <main> it points at, in a module without hooks so a
// server component (the public layout) can import it. Screens render their own <h1> and content and never their own <main>.
import type { ReactElement, ReactNode } from "react";
import { message } from "../copy/en.ts";

export const MAIN_ID = "kauro-main";

export function SkipLink(): ReactElement {
  return (
    <a className="kauro-skip-link" href={`#${MAIN_ID}`}>
      {message("shell.skip-link.label")}
    </a>
  );
}

export function Main({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <main id={MAIN_ID} className="kauro-main" tabIndex={-1}>
      {children}
    </main>
  );
}

/** The frame of a public screen: the skip link and the landmark. The public site's own header and footer are its screens' concern. */
export function PublicFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <>
      <SkipLink />
      <Main>{children}</Main>
    </>
  );
}
