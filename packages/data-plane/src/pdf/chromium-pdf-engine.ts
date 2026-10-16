/**
 * ChromiumPdfEngine — the PdfEngine of @kauro/reports (B13; design docs/design/B13-report-pdf.md). It prints the inert report HTML
 * with a Chromium it is handed the path of (Chrome, Chromium or Edge; Playwright's driver only, no bundled browser download).
 *
 * - The browser's own sandbox stays on (`chromiumSandbox: true`; the driver's default `--no-sandbox` is removed). If the host cannot
 *   run the sandboxed browser, printing fails: it is never retried unsandboxed.
 * - JavaScript is off, the context is offline, service workers are blocked and every request is aborted; any request the document
 *   makes (other than its own `data:` logo) fails the print rather than producing a PDF that silently lacks a resource.
 * - One fresh browser and context per print, closed in `finally`; a time limit bounds each print.
 * - The PDF is tagged (selectable text, structure for assistive technology) and sized by the document's own `@page` (Letter / A4).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import type { PdfEngine, PdfPrintRequest } from "@kauro/reports";
import { ReportPdfError } from "@kauro/reports";

export interface ChromiumPdfEngineOptions {
  /** Absolute path of a Chromium-family executable. */
  readonly executablePath: string;
  /** Upper bound for one print, milliseconds. Default 60 000. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The one way the engine starts a browser: headless, with the browser's own sandbox (no `--no-sandbox`, never retried without it). */
const launchOptionsOf = (executablePath: string, timeout: number) => ({ executablePath, headless: true, chromiumSandbox: true, timeout }) as const;

/** What a sandbox self-check observed in the running browser's process tree (Linux only; see `ChromiumPdfEngine.probe`). */
export interface ChromiumProbe {
  readonly version: string;
  readonly platform: string;
  /** Linux: the browser's descendants as the kernel reports them; null elsewhere. */
  readonly processes: ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly comm: string; readonly type: string; readonly seccomp: number | null; readonly noNewPrivs: number | null }> | null;
  /** Linux: whether any process of the tree carries a flag that turns a sandbox layer off. */
  readonly sandboxDisabledFlag: boolean | null;
}

const SANDBOX_OFF_FLAGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-seccomp-filter-sandbox", "--disable-gpu-sandbox", "--disable-namespace-sandbox"];

/** The Linux process tree below the browser Playwright started (found by its `--remote-debugging-pipe` and temporary profile). */
function browserTreeOf(): Array<{ pid: number; ppid: number; comm: string; args: string[]; status: string }> {
  const all = new Map<number, { ppid: number; comm: string; args: string[]; status: string }>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? "0");
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter((a) => a !== "");
      all.set(Number(name), { ppid, comm: readFileSync(`/proc/${name}/comm`, "utf8").trim(), args, status });
    } catch {
      // the process ended while it was read
    }
  }
  const roots = [...all.entries()].filter(([, v]) => v.args.includes("--remote-debugging-pipe") && !v.args.some((a) => a.startsWith("--type=")));
  const tree = new Map<number, { pid: number; ppid: number; comm: string; args: string[]; status: string }>();
  const visit = (pid: number): void => {
    const entry = all.get(pid);
    if (entry === undefined || tree.has(pid)) return;
    tree.set(pid, { pid, ppid: entry.ppid, comm: entry.comm, args: entry.args, status: entry.status });
    for (const [child, v] of all) if (v.ppid === pid) visit(child);
  };
  for (const [pid] of roots) visit(pid);
  return [...tree.values()];
}
/** Largest HTML document handed to the browser: a report is a few hundred KiB; this refuses a runaway input before launching. */
export const PDF_HTML_MAX_BYTES = 8 * 1024 * 1024;

/** The first Chromium-family executable found at a conventional location, or null. `explicit` (e.g. a deployment setting) wins. */
export function findChromiumExecutable(explicit: string | null = null, platform: string = process.platform): string | null {
  const candidates =
    platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
      : platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const path of explicit === null ? candidates : [explicit]) if (existsSync(path)) return path;
  return null;
}

export class ChromiumPdfEngine implements PdfEngine {
  readonly engineId: string;
  readonly #executablePath: string;
  readonly #timeoutMs: number;

  constructor(options: ChromiumPdfEngineOptions, engineId = "chromium") {
    this.#executablePath = options.executablePath;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.engineId = engineId;
  }

  async print(request: PdfPrintRequest): Promise<Uint8Array> {
    if (Buffer.byteLength(request.html, "utf8") > PDF_HTML_MAX_BYTES) throw new ReportPdfError("ENGINE_FAILED", "the document is larger than the print limit");
    if (!existsSync(this.#executablePath)) throw new ReportPdfError("ENGINE_FAILED", "the PDF browser executable was not found");
    const browser = await chromium.launch(launchOptionsOf(this.#executablePath, this.#timeoutMs));
    try {
      const context = await browser.newContext({ javaScriptEnabled: false, offline: true, serviceWorkers: "block", acceptDownloads: false, bypassCSP: false });
      context.setDefaultTimeout(this.#timeoutMs);
      const refused: string[] = [];
      await context.route("**/*", async (route) => {
        const scheme = route.request().url().split(":", 1)[0];
        if (scheme !== "data" && scheme !== "about") refused.push(String(scheme));
        await route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.on("request", (r) => {
        const scheme = r.url().split(":", 1)[0];
        if (scheme !== "data" && scheme !== "about" && scheme !== "blob") refused.push(String(scheme));
      });
      await page.setContent(request.html, { waitUntil: "load", timeout: this.#timeoutMs });
      const pdf = await page.pdf({
        format: request.pageSize === "A4" ? "A4" : "Letter",
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: false,
        tagged: true,
        outline: false,
      });
      if (refused.length > 0) throw new ReportPdfError("ENGINE_FAILED", `the document requested a resource outside itself (${[...new Set(refused)].join(", ")}); nothing was printed`);
      return new Uint8Array(pdf);
    } catch (error) {
      if (error instanceof ReportPdfError) throw error;
      throw new ReportPdfError("ENGINE_FAILED", "the browser could not print the document", error);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /** Engine identity with the browser's real version, e.g. `chromium/155.0.7000.0`. */
  static async identify(executablePath: string): Promise<string> {
    const browser = await chromium.launch(launchOptionsOf(executablePath, DEFAULT_TIMEOUT_MS));
    try {
      return `chromium/${browser.version()}`;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /**
   * Starts the browser exactly as `print` does, opens a page, and (on Linux) reads back from the kernel what the sandbox really did:
   * the process tree's `--type`, `Seccomp` and `NoNewPrivs`, and whether any process carries a flag that disables a sandbox layer.
   * A sandboxed renderer reports `Seccomp: 2` and `NoNewPrivs: 1`. It prints nothing and keeps nothing.
   */
  static async probe(executablePath: string): Promise<ChromiumProbe> {
    const browser = await chromium.launch(launchOptionsOf(executablePath, DEFAULT_TIMEOUT_MS));
    try {
      const context = await browser.newContext({ javaScriptEnabled: false, offline: true, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.setContent("<!DOCTYPE html><html><body><p>probe</p></body></html>", { waitUntil: "load" });
      const version = `chromium/${browser.version()}`;
      if (process.platform !== "linux") return { version, platform: process.platform, processes: null, sandboxDisabledFlag: null };
      const tree = browserTreeOf();
      const processes = tree.map((p) => ({
        pid: p.pid,
        ppid: p.ppid,
        comm: p.comm,
        type: p.args.find((a) => a.startsWith("--type="))?.slice("--type=".length) ?? "browser",
        seccomp: Number(/^Seccomp:\s+(\d+)/m.exec(p.status)?.[1] ?? Number.NaN),
        noNewPrivs: Number(/^NoNewPrivs:\s+(\d+)/m.exec(p.status)?.[1] ?? Number.NaN),
      }));
      return {
        version,
        platform: process.platform,
        processes: processes.map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm, type: p.type, seccomp: Number.isNaN(p.seccomp) ? null : p.seccomp, noNewPrivs: Number.isNaN(p.noNewPrivs) ? null : p.noNewPrivs })),
        sandboxDisabledFlag: tree.some((p) => p.args.some((a) => SANDBOX_OFF_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)))),
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}
