/**
 * Salesforce Data Loader, driven headlessly, from this repository.
 *
 * WHY THIS FILE IS HERE AND NOT IN THE AUTH DIRECTORY. It used to be
 * `<auth>/dl/run.mjs`, beside the jar, and it is gone — the `dl` directory was
 * re-extracted from the release zip at some point and took the wrapper with it,
 * so `SF-TARGET-01` and `SF-OCR-01` could not be re-run at all. The evidence
 * files stayed in the repository looking healthy while the thing that produced
 * them had ceased to exist.
 *
 * A qualification that depends on an untracked file on one laptop is not a
 * qualification anybody else can repeat, and the auth directory should hold
 * credentials and nothing else. So the driver is code and lives with the code;
 * what stays outside is the credential, and the vendor's own jar, which is not
 * ours to vendor.
 *
 * ---- how the login used to work, and why that was disqualifying ----
 *
 * Historical, and kept because it is the reason this file exists in its present
 * shape rather than the shape it had.
 *
 * This drove the vendor's batch `process` entry point, which in v67 begins with
 * a browser OAuth PKCE flow. `OAuthFlowHandler.handleOAuthLogin` logs "Starting
 * OAuth flow" and then, on the next line with nothing consulted in between,
 * "Attempting OAuth WebServer with PKCE flow, launching browser for login". It
 * opens a callback server on localhost:7171, launches the machine's default
 * browser, and completes only because somebody is already signed in to
 * Salesforce there. Supplying `sfdc.oauth.accesstoken` does not change it: the
 * token was passed encrypted against `~/.dataloader/dataLoader.key`, named by
 * `process.encryptionKeyFile`, with the endpoint set to the instance that minted
 * it — all three of the things the auth note says must be right — and the
 * browser flow started anyway and timed out after sixty seconds.
 *
 * Observed rather than reasoned about: on 2026-09-07 the flow completed in forty
 * seconds with nobody touching anything at 03:00, failed at 06:10 with the same
 * cookies still on disk, and completed again immediately after the default
 * browser was started. What it needs is not a session that once existed but a
 * browser *process*, running and signed in.
 *
 * Three things followed, and each of them is on its own disqualifying for a
 * qualification:
 *
 *   - it could not run where nobody was signed in, so the gate could not run in
 *     CI and could not be repeated by anybody but one operator at one desk;
 *   - the records it created were owned by that browser session's user, not by
 *     the integration principal the evidence names;
 *   - it opens the owner's browser, which MC-3 forbids outright.
 *
 * ---- how it works now ----
 *
 * Through `dataloader-headless.mjs`, which drives the **unmodified official jar**
 * through its own public API — `Controller`, `LoginClient` — with a session
 * minted from the already-authorised integration credential and handed to the
 * launcher on a protected channel rather than on a command line, in an
 * environment variable, or in a file under version control.
 *
 * No fictitious password, no reflection into private methods, no altered jar, no
 * borrowed cookie. The launcher is told which org and which user the session
 * must land on and refuses if the login lands elsewhere, and afterwards it scans
 * the Data Loader log it just produced for the browser-flow markers and reports
 * what it found. `headless: true` on its own proves nothing; the markers and the
 * identity check are what the evidence rests on.
 *
 * The call signature is the one the runners already used. What changed is how
 * the login happens, not what the gates ask.
 */
import { join } from 'node:path';

import { compileLauncher, jarPath, mintSession, runLauncher } from './dataloader-headless.mjs';

/**
 * Every launch this process made, for the gates that assert about the login.
 *
 * A gate cannot show that no browser was opened by failing to see one. It shows
 * it by recording, for each launch, the exit class the launcher reported,
 * whether any of the Data Loader log's browser-flow markers appeared, whether
 * the token leaked into any file the run wrote, and the digest of the log those
 * questions were asked of.
 */
export const launches = [];

/**
 * One Data Loader operation, headless, on the integration credential.
 *
 * @param {{
 *   name: string,
 *   entity: string,
 *   operation: string,
 *   externalIdField?: string,
 *   inputCsv: string,
 *   mapping: ReadonlyArray<readonly [string, string]>,
 *   outDir: string,
 *   authDir: string,
 *   expectedOrgId?: string|null,
 *   expectedUserId?: string|null,
 *   session?: {accessToken: string, instanceUrl: string}|null,
 *   compiled?: {classesDir: string}|null,
 * }} input
 */
export function runDataLoader({
  name,
  entity,
  operation,
  externalIdField,
  inputCsv,
  mapping,
  outDir,
  authDir,
  expectedOrgId = null,
  expectedUserId = null,
  session = null,
  compiled = null,
}) {
  const jar = jarPath(authDir);
  const classes = compiled ?? compileLauncher({ jar, classesDir: join(authDir, 'qual', 'launcher-classes') });
  const minted = session ?? mintSession(authDir);
  const result = runLauncher({
    runDir: outDir,
    jar,
    classesDir: classes.classesDir,
    entity,
    operation,
    externalIdField,
    inputCsv,
    mapping,
    expectedOrgId,
    expectedUserId,
    session: minted,
  });
  launches.push({
    name,
    entity,
    operation,
    exitClass: result.exitClass,
    status: result.status,
    wallMs: result.wallMs,
    browserFlowEntered: result.browserFlowEntered,
    browserMarkersInLog: result.browserMarkersInLog,
    tokenLeaks: result.tokenLeaks,
    logSha256: result.logSha256,
  });
  return {
    success: result.success,
    error: result.error,
    stdout: result.stdout,
    status: result.status,
    headless: result,
  };
}
