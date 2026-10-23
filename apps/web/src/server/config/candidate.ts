import "server-only";

// The only reader of KAURO_CANDIDATE_CLEAN_NO_TARGET in the web (Order 24; the api's own switch of the same name, Order 20): "Clean your
// data" with no target contract, built against the O19A candidate. Off unless exactly "true", and only in the LOCAL environment until Order
// 19B adopts the candidate, as the api refuses it elsewhere. Read on each call; a server page hands the answer to its client container.
export function candidateCleanWithoutTarget(): boolean {
  return process.env["KAURO_ENV"] === "LOCAL" && process.env["KAURO_CANDIDATE_CLEAN_NO_TARGET"] === "true";
}
