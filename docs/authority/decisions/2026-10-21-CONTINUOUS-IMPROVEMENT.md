# Decision D-34: continuous improvement and coordinated functional change (2026-10-21)

Status: owner decision, 2026-10-21. In force from that date. It changes how decisions are weighed and how functional change is
planned; it supersedes no clause of an earlier decision by itself.

Naming: "D-34" is this owner decision, numbered after D-33. It is distinct from any R2 design decision numbered D34 in the authority
registry, which stays in force unchanged.

## 1. Earlier decisions are evidence, not automatic vetoes

1.1. Earlier decisions, approved designs and existing contracts (registries, policies, the DPA, the terms, the api contract) are
**evidence and transition constraints**. They are not, by themselves, a reason to reject a materially better solution.

1.2. When research finds a material improvement, it is **proposed** with its effects on: policies, contracts and legal texts,
backend and data, security and privacy, costs, the customer's experience, and tests. The earlier decision may then be **kept,
modified or replaced** according to that evaluation, and the owner decides.

1.3. Nothing here weakens a rule that protects a person or the law: a change to a versioned legal text still follows its own
procedure; a change to a registry still goes through a ChangeProposal and a new version (28 §How a change is made); security,
accessibility and copy contracts still apply until they are changed by that route.

## 2. Orders 11 and 12: design only

2.1. During Orders 11 and 12, work continues **only on design** (visual design, the review environment, and the written record of
every improvement and of the functional change it needs). The cores are not modified and no new function is deployed.

2.2. Each design that needs a functional change records it, with the component it opens and its dependencies, in
`docs/design/ORDER11-FUNCTIONAL-GAPS.md` (F-entries) or the round's own decision files.

## 3. One coordinated intervention per component

3.1. Before the functional orders begin, a **cross-transversal inventory** consolidates every recorded change and its
dependencies, grouped by the component it opens (policy, legal texts, registry and api contract, backend domain and data,
payments, deletion and retention, restoration, abuse controls, identity, cores, tests). The inventory lives in
`docs/design/FUNCTIONAL-CHANGE-INVENTORY.md`.

3.2. Changes that open the same component are resolved in **one coordinated intervention**, ordered by their dependencies, so that a
component is opened, changed and tested once rather than in repeated cycles. Each intervention keeps the full review: acceptance
tests first, the full verify, the independent review, and regression tests for every behaviour it touches.

3.3. The goal is to avoid repeated cycles of change and testing without introducing regressions or loosening review.

## 4. Merges

4.1. No pull request of Order 11 (PR #118) is merged without the owner's final approval. During round 2, finished work is shown
on the local review first and pushed once, after the owner says it is ready.
