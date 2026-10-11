// node:test reporter for the builder gates: one JSON line per test event, so the gates never parse spec text.
// Destination file comes from the environment (KAURO_TEST_EVENTS); stdout stays free for a human reporter.
import { appendFileSync, writeFileSync } from "node:fs";

const MAX_MESSAGE = 500;

function firstMessage(error) {
  const message = error?.cause?.message ?? error?.message;
  return typeof message === "string" ? message.split(/\r?\n/)[0].slice(0, MAX_MESSAGE) : null;
}

export default async function* kauroTestEvents(source) {
  const path = process.env.KAURO_TEST_EVENTS;
  if (!path) throw new Error("KAURO_TEST_EVENTS must name the event file");
  writeFileSync(path, "");
  const write = (record) => appendFileSync(path, JSON.stringify(record) + "\n");
  const counts = {};
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === "test:pass" || event.type === "test:fail") {
      const failed = event.type === "test:fail";
      const error = data.details?.error;
      write({
        event: failed ? "fail" : "pass", name: data.name, nesting: data.nesting, file: data.file ?? null,
        kind: data.details?.type ?? "test", skip: data.skip !== undefined && data.skip !== false,
        todo: data.todo !== undefined && data.todo !== false,
        failureType: failed ? error?.failureType ?? null : null,
        message: failed ? firstMessage(error) : null,
      });
    } else if (event.type === "test:diagnostic") {
      const match = /^(\w+) ([0-9.]+)$/.exec(data.message ?? "");
      if (match) counts[match[1]] = Number(match[2]);
    }
  }
  write({ event: "summary", counts });
}
