// Fixtures of the Migration Core adapter tests (B05 L1): a closed MigrationConfig over one CSV, the host's in-memory ports.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sha256Hex } from "@kauro/contracts";
import type { ArtifactHandle, ArtifactWriter, CoreInputRef, CoreInputResolver, HostIo, SourceHandle, SourceReader, StagedArtifact } from "@kauro/application";
import { limitsOf, manualChannel, sha } from "./attempt.js";

export const CONTACTS_CSV = "Id,Email,Name\n1,a@example.com,Ann\n2,b@example.com,Bob\n3,c@example.com,Cy\n";

export function configDocument(path = "contacts.csv"): Record<string, unknown> {
  return {
    configVersion: "3.0.0",
    source: { system: "crm", namespace: "acme" },
    target: { mode: "CLEAN_ONLY", importMode: "CREATE_ONLY" },
    files: [{ id: "contacts", path, format: "CSV" }],
    records: [
      {
        id: "contacts",
        fileId: "contacts",
        object: "CONTACT",
        sourceRecordIdColumn: { header: "Id" },
        fields: [
          { column: { header: "Email" }, destinationField: "contact.email", semanticType: "EMAIL" },
          { column: { header: "Name" }, destinationField: "custom:name", semanticType: "TEXT" },
        ],
      },
    ],
  };
}

export interface MemorySource extends SourceReader {
  opened: number;
}

export function memorySource(files: Record<string, string | Buffer>): MemorySource {
  const reader: MemorySource = {
    opened: 0,
    open(ref): Promise<SourceHandle> {
      reader.opened += 1;
      const bytes = Buffer.from(files[`${ref.objectName}#${ref.generation}`] ?? "");
      return Promise.resolve({ byteLength: bytes.byteLength, sha256: sha(bytes), read: async function* () { yield bytes; } });
    },
  };
  return reader;
}

export function inputRef(objectName: string, text: string | Buffer, generation = "1"): CoreInputRef {
  const bytes = Buffer.from(text);
  return { objectName, generation, sha256: sha(bytes), byteLength: bytes.byteLength, readConfig: { format: "CSV", encoding: null, delimiter: null, sheets: null } };
}

export function resolverOf(refs: readonly CoreInputRef[]): CoreInputResolver {
  return { resolve: () => Promise.resolve(refs) };
}

export interface MemoryWriter extends ArtifactWriter {
  readonly staged: Map<string, { artifact: StagedArtifact; bytes: Buffer }>;
}

export function memoryWriter(): MemoryWriter {
  const staged = new Map<string, { artifact: StagedArtifact; bytes: Buffer }>();
  return {
    staged,
    open(role: string, pathHash: Sha256Hex): ArtifactHandle {
      const parts: Buffer[] = [];
      return {
        write: (chunk) => {
          parts.push(Buffer.from(chunk));
          return Promise.resolve();
        },
        close: () => {
          const bytes = Buffer.concat(parts);
          const artifact: StagedArtifact = { role, objectName: `staging/${pathHash}`, generation: "1", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
          staged.set(`${role}:${pathHash}`, { artifact, bytes });
          return Promise.resolve(artifact);
        },
      };
    },
  };
}

export function hostIoOf(options: { source: SourceReader; writer?: ArtifactWriter; scratchBytes?: number; channel?: ReturnType<typeof manualChannel> }): HostIo & { writer: MemoryWriter } {
  const writer = (options.writer ?? memoryWriter()) as MemoryWriter;
  const scratch = { usage: () => ({ bytes: 0, peakBytes: 0, quotaBytes: 0, segmentCount: 0, bytesWritten: 0, byFamily: [], framingBytesPerLine: 0 }) } as unknown as HostIo["scratch"];
  return { source: options.source, scratch, writer, cancellation: options.channel ?? manualChannel(), limits: limitsOf(options.scratchBytes ?? 256 * 1024 * 1024) };
}

export function tempRoot(): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "kauro-b05-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** A virtual clock: `advance` fires the due timers in order; nothing here sleeps. */
export class ManualTimers {
  now = Date.now();
  readonly #timers: Array<{ at: number; fire: () => void; live: boolean }> = [];
  nowMs = (): number => this.now;
  after = (ms: number, fire: () => void): (() => void) => {
    const entry = { at: this.now + Math.max(0, ms), fire, live: true };
    this.#timers.push(entry);
    return () => {
      entry.live = false;
    };
  };
  /** Moves the clock and fires what is due; callers then `await settle()` for the promise continuations. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      this.now = Math.max(this.now, due.at);
      due.fire();
    }
    this.now = target;
  }
}

export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A promise a test resolves by hand. */
export function gate(): { promise: Promise<void>; open(): void; opened: boolean } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  const g = { promise, opened: false, open: () => { g.opened = true; open(); } };
  return g;
}
