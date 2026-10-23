// What the page does with an answer that asks for more assurance (O23A; B11 D-AUTH-4). The api answers 403 ASSURANCE_REQUIRED with a
// reason; the page maps the reason to its next step and never retries the command on its own. Pure: the screen decides how it shows it.

export type AssuranceReason = "EMAIL_NOT_VERIFIED" | "MFA_NOT_ENROLLED" | "STEP_UP_MISSING" | "STEP_UP_STALE" | "STEP_UP_NOT_OWNED";

export type AssuranceStep =
  | { readonly kind: "VERIFY_EMAIL" }
  | { readonly kind: "ENROL_SECOND_FACTOR" }
  | { readonly kind: "REAUTHENTICATE"; readonly purpose: "STEP_UP" }
  | { readonly kind: "SIGN_IN_AGAIN" };

export function assuranceStepOf(reason: string | undefined): AssuranceStep {
  switch (reason) {
    case "EMAIL_NOT_VERIFIED":
      return { kind: "VERIFY_EMAIL" };
    case "MFA_NOT_ENROLLED":
      return { kind: "ENROL_SECOND_FACTOR" };
    case "STEP_UP_MISSING":
    case "STEP_UP_STALE":
      return { kind: "REAUTHENTICATE", purpose: "STEP_UP" };
    default:
      // another person's re-authentication, or a reason this page does not know: the safe step is a fresh sign-in
      return { kind: "SIGN_IN_AGAIN" };
  }
}
