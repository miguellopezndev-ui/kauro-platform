/**
 * The worker's end of its host's channel (B14-A; framing.ts): the pipe the host gave it as fd 3, read and written in the protocol's own
 * frames. The worker's children never get it: the process allowlist (worker-preload.ts) gives every child's fd 3 a stdio entry of its
 * own, so the descriptor is replaced in the child before its program runs.
 */
import net from "node:net";
import { encodeFrame, FrameDecoder } from "./framing.js";
import type { HostMessage, WorkerMessage } from "./protocol.js";

/** The descriptor a host hands its worker's channel on. */
export const WORKER_CHANNEL_FD = 3;

export interface WorkerChannel {
  /** Sends one message; `written` once it is out of this process. Throws when the channel is closed. */
  send(message: WorkerMessage, written?: () => void): void;
  /** Whether the channel can still carry a message. */
  readonly open: boolean;
  /** Ends the channel at once (the host reads what was already written). */
  close(): void;
}

/**
 * Opens the channel on fd 3, or null when this process has none. Every host message goes to `receive`; `closed` runs once, when the
 * host's end closes or a frame from it is not one of the protocol's.
 */
export function openWorkerChannel(receive: (message: HostMessage) => void, closed: () => void): WorkerChannel | null {
  let socket: net.Socket;
  try {
    socket = new net.Socket({ fd: WORKER_CHANNEL_FD, readable: true, writable: true });
  } catch {
    return null;
  }
  // the host's frames: a ticket is at most the ticket's own bound, a reply's bytes at most one read chunk
  const decoder = new FrameDecoder();
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    socket.destroy();
    closed();
  };
  socket.on("data", (bytes: Buffer) => {
    let messages: Record<string, unknown>[];
    try {
      messages = decoder.push(bytes);
    } catch {
      end();
      return;
    }
    for (const message of messages) receive(message as unknown as HostMessage);
  });
  socket.on("error", end);
  socket.on("close", end);
  socket.on("end", end);
  return {
    send(message: WorkerMessage, written?: () => void): void {
      if (ended || socket.destroyed) throw new Error("the host's channel is closed");
      socket.write(encodeFrame(message), () => written?.());
    },
    get open(): boolean {
      return !ended && !socket.destroyed;
    },
    close(): void {
      ended = true;
      socket.destroy();
    },
  };
}
