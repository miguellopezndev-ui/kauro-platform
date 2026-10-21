"use client";
// A value the person types into another tool (a bank's transfer form): a button copies it exactly, so a reference or an account number is
// never retyped (research: app-ui-patterns.md §7, a copy button on every bank detail). The button names what it copies, and its result is
// announced once in a polite live region; where the clipboard is refused, it says to select the value instead, which stays selectable.
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { message } from "../../copy/en.ts";

type Result = "IDLE" | "COPIED" | "REFUSED";

export function CopyValue({ value, label }: { readonly value: string; readonly label: string }): ReactElement {
  const [result, setResult] = useState<Result>("IDLE");
  useEffect(() => {
    if (result === "IDLE") return;
    const timer = setTimeout(() => setResult("IDLE"), 4000);
    return () => clearTimeout(timer);
  }, [result]);
  const copy = (): void => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setResult("REFUSED");
      return;
    }
    clipboard.writeText(value).then(
      () => setResult("COPIED"),
      () => setResult("REFUSED"),
    );
  };
  return (
    <span className="kauro-copy">
      <button type="button" className="kauro-copy-button" onClick={copy}>
        {message("screen.copy.label")}
        <span className="kauro-visually-hidden-text"> {label}</span>
      </button>
      <span className="kauro-copy-result" role="status">
        {result === "COPIED" ? message("screen.copy.done") : result === "REFUSED" ? message("screen.copy.refused") : ""}
      </span>
    </span>
  );
}
