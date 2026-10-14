"use client";
// The browser's PUT of a file to the provider's upload session (UI14; design D-SCR-3). The address and its origin are decided by
// `uploadTarget` before this runs; this module only moves bytes and reports progress. XMLHttpRequest because fetch reports no upload
// progress. No cookie and no application header goes to the provider: the session URL is the credential.
import type { PutResult, UploadProgress, UploadTransport } from "./model.ts";

const MAX_REF = 4096;

export const browserUploadTransport: UploadTransport = {
  put({ url, body, onProgress }): Promise<PutResult> {
    return new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.open("PUT", url);
      request.withCredentials = false;
      request.upload.onprogress = (event) => {
        const progress: UploadProgress = { sent: event.loaded, total: event.lengthComputable ? event.total : body.size };
        onProgress(progress);
      };
      request.onerror = () => resolve({ kind: "FAILED", status: null });
      request.onabort = () => resolve({ kind: "FAILED", status: null });
      request.ontimeout = () => resolve({ kind: "FAILED", status: null });
      request.onload = () => {
        if (request.status < 200 || request.status > 299) {
          resolve({ kind: "FAILED", status: request.status });
          return;
        }
        // the provider's completion token: its answer body when it sends one, otherwise its entity tag; opaque to the page, forwarded to CMD014
        const token = (request.responseText.trim() !== "" ? request.responseText.trim() : (request.getResponseHeader("ETag") ?? "")).slice(0, MAX_REF);
        resolve(token === "" ? { kind: "FAILED", status: request.status } : { kind: "SENT", completionRef: token });
      };
      request.send(body);
    });
  },
};
