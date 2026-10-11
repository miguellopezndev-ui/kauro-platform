// The defect families of the final audit, pinned: exactly the nine ids of C:\Projects\Kauro\tools\review\families.md (census 9; that
// file's line 20: "Nothing outside these rows is a finding unless it makes a registry case outcome false (then use `evidence`)").
// A finding carries exactly one of them. Adding or removing one is a change of that table and of this list together (test K-10).
export const FAMILIES = Object.freeze(["concurrency", "time", "crash", "retry", "revocation", "partial", "evidence", "money", "tenant"]);
