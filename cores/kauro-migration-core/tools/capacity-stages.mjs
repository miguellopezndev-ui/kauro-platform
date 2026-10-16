/**
 * The stages a capacity reproduction is measured in.
 *
 * A leaf on purpose. The producer (`tools/capacity.mjs`) and the validator
 * (`tools/evidence-schema.mjs`) both need this list, and when it lived in the
 * validator the producer's dependency closure contained the validator — so a
 * change to how evidence is *checked* fingerprinted as a change to how it was
 * *produced*, and invalidated measurements it could not have affected. Producer
 * and validator now share this file and nothing else.
 */
export const CAPACITY_STAGES = Object.freeze(['profile', 'run', 'package', 'verify', 'attest', 'cleanup']);
