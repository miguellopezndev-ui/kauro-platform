-- Migration 0075: B17 L2 PROFILE, the control plane reads the one column of a target contract that its body digest needs
-- (provisional number; the coordinator renumbers on merge).
--
-- docs/design/B15-B17-B18-local-plan.md cell M3: PLAN_VALIDATION recomputes the KAURO_TARGET_BODY_V1 digest of the target body a plan
-- binds and refuses TARGET_DIGEST_MISMATCH when it is not the intent's targetContractHash. The digest's preimage names
-- authority_evidence_hash, which 0021's column grant to kauro_control left out. It is a SHA-256 of evidence and names no customer value.
-- A column grant only: no policy, no function (the existing target_contracts_control_execution_read policy still bounds the rows to the
-- unit's agency; template rule 21a, a policy never names another relation).
GRANT SELECT (authority_evidence_hash) ON kauro.target_contracts TO kauro_control;
