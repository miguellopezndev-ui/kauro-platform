// The synthetic ids of the review's project, shared with the web's unit-test fixtures (so a fixture built there names the same project).
import { JOB } from "@web-test/fixtures-processing.ts";
import { AUDIT, ORDER, PROJECT, QUOTE } from "@web-test/fixtures.ts";

export const IDS = { project: PROJECT, quote: QUOTE, order: ORDER, audit: AUDIT, job: JOB } as const;
