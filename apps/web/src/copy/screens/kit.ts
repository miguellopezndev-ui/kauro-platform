// The copy of the shared kit of the stage-2 screens (design D-COPY-1): the step-up state every sensitive command can end in.
export const KIT_COPY = {
  "screen.step-up.title": "Confirm it is you",
  "screen.step-up.body": "This action needs a fresh confirmation of your identity. What you entered is kept.",
  "screen.step-up.cta": "Confirm identity",
} as const satisfies Readonly<Record<string, string>>;
