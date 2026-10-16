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
import { existsSync } from "node:fs";
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
    const browser = await chromium.launch({ executablePath: this.#executablePath, headless: true, chromiumSandbox: true, timeout: this.#timeoutMs });
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
    const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
    try {
      return `chromium/${browser.version()}`;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}
