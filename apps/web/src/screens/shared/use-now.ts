"use client";
// The one place a screen reads the browser clock (design D-STATE-1: the web judges no instant). The value only ever disables a control
// whose deadline the server told it; the server decides again when the command arrives. A test passes its own `read`.
import { useEffect, useState } from "react";

export const DEFAULT_TICK_MS = 15_000;

export function useNow(intervalMs: number = DEFAULT_TICK_MS, read: () => number = () => Date.now()): number {
  const [now, setNow] = useState(read);
  useEffect(() => {
    const timer = setInterval(() => setNow(read()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, read]);
  return now;
}
