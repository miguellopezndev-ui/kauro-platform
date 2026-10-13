"use client";
// A paged list of a screen (design D-STATE-1; cases W-READ). The rules the kit holds for every list:
//   - earlier pages stay on screen while a later page loads or fails;
//   - the only cursor ever sent is one the server issued with the previous page (`more` takes no argument: a cursor cannot be made up);
//   - a page that answers another version than the pages held means the list changed under the reader: every page is dropped (CHANGED)
//     and nothing more is asked for until the list is read again from its start with `first`;
//   - an answer that arrives after a newer read began is dropped (a stale page never lands on a newer list);
//   - a lost or refused page leaves the pages and the cursor as they were, so a retry repeats the very same request.
import { useEffect, useRef, useState } from "react";
import type { ApiAnswer } from "../../client/answer.ts";
import { type StateDecision, stateOfAnswer } from "../../client/states.ts";

export interface PageOf<Item> {
  readonly items: readonly Item[];
  /** The cursor the server issued for the next page; null on the last page. */
  readonly nextCursor: string | null;
  /** What the pages of one list have in common: when it differs between two pages the list changed. */
  readonly version: string;
}

export interface PagedSource<Body, Item> {
  readonly load: (cursor: string | null, signal: AbortSignal) => Promise<ApiAnswer<Body>>;
  readonly pageOf: (body: Body) => PageOf<Item>;
}

export interface PagedState<Item> {
  readonly status: "IDLE" | "LOADING" | "READY" | "FAILED" | "CHANGED";
  readonly items: readonly Item[];
  readonly hasMore: boolean;
  /** The state of the last page that did not arrive (FAILED), for the shared state panel. */
  readonly failure: StateDecision | null;
}

const IDLE = { status: "IDLE", items: [], hasMore: false, failure: null } as const;

export class PagedRead<Body, Item> {
  readonly #source: PagedSource<Body, Item>;
  readonly #listeners = new Set<() => void>();
  #items: readonly Item[] = [];
  #cursor: string | null = null;
  #version: string | null = null;
  #generation = 0;
  #controller: AbortController | null = null;
  #state: PagedState<Item> = IDLE;

  constructor(source: PagedSource<Body, Item>) {
    this.#source = source;
  }

  get state(): PagedState<Item> {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Reads the list from its start; whatever was held, and any read in flight, is replaced. */
  async first(): Promise<void> {
    this.#items = [];
    this.#cursor = null;
    this.#version = null;
    await this.#read(null);
  }

  /** Reads the page the server named; nothing when there is none, or while a read is in flight. */
  async more(): Promise<void> {
    if (this.#cursor === null || this.#state.status === "LOADING" || this.#state.status === "CHANGED") return;
    await this.#read(this.#cursor);
  }

  abort(): void {
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = null;
  }

  #publish(state: PagedState<Item>): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  async #read(cursor: string | null): Promise<void> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    this.#generation += 1;
    const mine = this.#generation;
    this.#publish({ status: "LOADING", items: this.#items, hasMore: false, failure: null });
    const answer = await this.#source.load(cursor, controller.signal);
    if (mine !== this.#generation) return;
    if (answer.kind !== "REPLY") {
      this.#publish({ status: "FAILED", items: this.#items, hasMore: this.#cursor !== null, failure: stateOfAnswer(answer) });
      return;
    }
    const page = this.#source.pageOf(answer.body);
    if (this.#version !== null && page.version !== this.#version) {
      this.#items = [];
      this.#cursor = null;
      this.#version = null;
      this.#publish({ status: "CHANGED", items: [], hasMore: false, failure: null });
      return;
    }
    this.#version = page.version;
    this.#items = [...this.#items, ...page.items];
    this.#cursor = page.nextCursor;
    this.#publish({ status: "READY", items: this.#items, hasMore: this.#cursor !== null, failure: null });
  }
}

/** The list as a hook: reads the first page when `identity` changes, and aborts on unmount. */
export function usePagedRead<Body, Item>(source: PagedSource<Body, Item>, identity: string): { readonly state: PagedState<Item>; readonly more: () => void; readonly reload: () => void } {
  const latest = useRef(source);
  latest.current = source;
  const [read] = useState(() => new PagedRead<Body, Item>({ load: (cursor, signal) => latest.current.load(cursor, signal), pageOf: (body) => latest.current.pageOf(body) }));
  const [state, setState] = useState<PagedState<Item>>(read.state);
  useEffect(() => {
    const stop = read.subscribe(() => setState(read.state));
    void read.first();
    return () => {
      stop();
      read.abort();
    };
  }, [read, identity]);
  return { state, more: () => void read.more(), reload: () => void read.first() };
}
