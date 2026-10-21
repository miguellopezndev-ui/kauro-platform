// The copy of the shared kit of the stage-2 screens (design D-COPY-1): the step-up state every sensitive command can end in.
export const KIT_COPY = {
  "screen.step-up.title": "Confirm it is you",
  "screen.step-up.body": "This action needs a fresh confirmation of your identity. What you entered is kept.",
  "screen.step-up.cta": "Confirm identity",
  // a value copied for another tool (shared/copy-value.tsx)
  "screen.copy.label": "Copy",
  "screen.copy.done": "Copied",
  "screen.copy.refused": "Copying is not allowed here: select the value instead.",
} as const satisfies Readonly<Record<string, string>>;
