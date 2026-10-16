/**
 * Data Loader, headless, through its public API and the Kauro launcher.
 *
 * `dataloader-launcher/KauroDataLoaderLauncher.java` is compiled here at run
 * time against the unmodified official jar and driven by `runLauncher`. The
 * token and the instance URL cross into the JVM on stdin and nowhere else;
 * every file the run leaves behind is scanned for the token bytes and the run
 * is refused if they are found. See the launcher's header for why this exists
 * and which Data Loader code path it uses.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DATA_LOADER_VERSION = '67.0.0';
export const LAUNCHER_SOURCE = join(here, 'dataloader-launcher', 'KauroDataLoaderLauncher.java');

/** Forward slashes, always: Java properties files and Data Loader eat backslashes. */
export const forward = (path) => resolve(path).split('\\').join('/');

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function jarPath(authDir) {
  const jar = join(authDir, 'dl', `dataloader-${DATA_LOADER_VERSION}.jar`);
  if (!existsSync(jar)) {
    throw new Error(
      `no Data Loader at ${jar}. The release jar is the vendor's and is not committed; put the official ${DATA_LOADER_VERSION} jar in <auth>/dl/ before running this gate.`,
    );
  }
  return jar;
}

/**
 * One value out of a shell `env`-style file, by name, read in-process.
 *
 * The value never reaches a command line or a log; the name is the only thing
 * an error message carries.
 */
export function fromShellFile(path, name) {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());
    if (match !== null && match[1] === name) return match[2].replace(/^["']|["']$/gu, '');
  }
  return null;
}

/**
 * A fresh client-credentials session from the already-authorised integration.
 *
 * `sf-token.sh` mints the token and writes it to `<auth>/session`; nothing about
 * the token is printed. The session file is then read here, in this process.
 */
export function mintSession(authDir) {
  execFileSync('bash', [forward(join(authDir, 'sf-token.sh'))], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  const sessionFile = join(authDir, 'session');
  const accessToken = fromShellFile(sessionFile, 'SF_ACCESS_TOKEN');
  const instanceUrl = fromShellFile(sessionFile, 'SF_INSTANCE_URL');
  if (accessToken === null || instanceUrl === null) {
    throw new Error('sf-token.sh left no SF_ACCESS_TOKEN / SF_INSTANCE_URL in <auth>/session');
  }
  return { accessToken, instanceUrl };
}

/** The version strings of the JDK in use, for the evidence. */
export function javaVersions() {
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  const javac = spawnSync('javac', ['-version'], { encoding: 'utf8' });
  return {
    java: `${java.stderr}${java.stdout}`.trim().split(/\r?\n/)[0] ?? '',
    javac: `${javac.stdout}${javac.stderr}`.trim().split(/\r?\n/)[0] ?? '',
  };
}

/**
 * Compile the launcher against the official jar.
 *
 * Compiled per run directory rather than committed as bytecode, so what runs is
 * always the source in this tree and the jar in hand. The source digest is
 * returned so the evidence can name it.
 */
export function compileLauncher({ jar, classesDir }) {
  mkdirSync(classesDir, { recursive: true });
  const result = spawnSync('javac', ['-encoding', 'UTF-8', '-cp', forward(jar), '-d', forward(classesDir), forward(LAUNCHER_SOURCE)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`javac failed (${String(result.status)}): ${result.stderr}`);
  }
  return {
    classesDir,
    launcherSourceSha256: sha256Of(readFileSync(LAUNCHER_SOURCE)),
    jarSha256: sha256Of(readFileSync(jar)),
    jarBytes: statSync(jar).size,
  };
}

/** Patterns that, present in the Data Loader log, would mean the browser flow was reached. */
export const BROWSER_FLOW_MARKERS = [/OAuthServerFlow/u, /OAuthFlowHandler/u, /launching browser/iu, /Starting OAuth flow/u, /PKCE/u, /localhost:7171/u];

/**
 * Run one Data Loader operation through the launcher.
 *
 * @param {object} input
 * @param {string} input.runDir a fresh directory for this operation's configuration, key file, log and results
 * @param {string} input.jar the official jar
 * @param {string} input.classesDir where `compileLauncher` put the launcher
 * @param {string} input.entity sObject API name
 * @param {'insert'|'update'|'upsert'|'delete'} input.operation
 * @param {string} [input.externalIdField]
 * @param {string} input.inputCsv
 * @param {Array<[string, string]>} input.mapping CSV header → field API name
 * @param {string} input.expectedOrgId the org the session must belong to, from the allowlist
 * @param {string} [input.expectedUserId]
 * @param {{accessToken: string, instanceUrl: string}} input.session
 * @param {number} [input.timeoutMs]
 */
export function runLauncher({
  runDir,
  jar,
  classesDir,
  entity,
  operation,
  externalIdField,
  inputCsv,
  mapping,
  expectedOrgId,
  expectedUserId,
  session,
  loadBatchSize = 200,
  timeoutSecs = 600,
  timeoutMs = 15 * 60 * 1000,
}) {
  const confDir = join(runDir, 'conf');
  const keyDir = join(runDir, 'key');
  mkdirSync(confDir, { recursive: true });
  mkdirSync(keyDir, { recursive: true });

  const sdl = join(confDir, `${operation}-${entity}.sdl`);
  writeFileSync(sdl, `${mapping.map(([column, field]) => `${column.split(' ').join('\\ ')}=${field}`).join('\n')}\n`);

  const logFile = join(runDir, 'dataloader.log');
  const log4j = join(confDir, 'log4j2.properties');
  writeFileSync(
    log4j,
    [
      'name = KauroDataLoaderLauncher',
      'appender.file.type = File',
      'appender.file.name = fileAppender',
      `appender.file.fileName = ${forward(logFile)}`,
      'appender.file.layout.type = PatternLayout',
      'appender.file.layout.pattern = %d %-5p [%t] %C{2} %M - %m%n',
      'rootLogger.level = info',
      'rootLogger.appenderRef.file.ref = fileAppender',
      '',
    ].join('\n'),
  );

  const successFile = join(runDir, 'success.csv');
  const errorFile = join(runDir, 'error.csv');
  // Removed before the launch, so what is read afterwards is this run's or
  // nothing.
  //
  // Run directories are named for the case, so a second run of a gate reuses
  // them. A load that failed left the previous run's success.csv in place and
  // the caller read it as this run's result: on 2026-09-08 the Data Loader gate
  // reported "Item Created" for an account created on the 7th, with the 7th's
  // external key, and then failed the cleanup because the ids it was deleting
  // had been deleted a day earlier. Twenty-three of its twenty-nine cases were
  // green against yesterday's files.
  rmSync(successFile, { force: true });
  rmSync(errorFile, { force: true });
  const keyFile = join(keyDir, 'dataloader.key');
  const spec = join(confDir, 'launcher.properties');
  const escapeProp = (value) => String(value).split('\\').join('/').split('=').join('\\=').split(':').join('\\:');
  const properties = [
    ['configDir', forward(confDir)],
    ['keyFile', forward(keyFile)],
    ['entity', entity],
    ['operation', operation],
    ['mappingFile', forward(sdl)],
    ['inputCsv', forward(inputCsv)],
    ['successFile', forward(successFile)],
    ['errorFile', forward(errorFile)],
    ['expectedOrgId', expectedOrgId],
    ['loadBatchSize', String(loadBatchSize)],
    ['timeoutSecs', String(timeoutSecs)],
  ];
  if (externalIdField !== undefined) properties.push(['externalIdField', externalIdField]);
  if (expectedUserId !== undefined) properties.push(['expectedUserId', expectedUserId]);
  writeFileSync(spec, `${properties.map(([key, value]) => `${key}=${escapeProp(value)}`).join('\n')}\n`);

  const classpath = [forward(jar), forward(classesDir)].join(process.platform === 'win32' ? ';' : ':');
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const child = spawnSync(
    'java',
    [`-Dlog4j2.configurationFile=${forward(log4j)}`, '-Djava.awt.headless=true', '-cp', classpath, 'KauroDataLoaderLauncher', forward(spec)],
    {
      encoding: 'utf8',
      input: `${session.accessToken}\n${session.instanceUrl}\n`,
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env, SF_ACCESS_TOKEN: '', SF_INSTANCE_URL: '' },
    },
  );
  const wallMs = Number((process.hrtime.bigint() - started) / 1000000n);

  // The key file is a per-run secret and does not outlive the run.
  rmSync(keyDir, { recursive: true, force: true });

  const stdout = child.stdout ?? '';
  const stderr = child.stderr ?? '';
  let report = null;
  const lastLine = stdout.trim().split(/\r?\n/).filter((line) => line.startsWith('{')).pop();
  if (lastLine !== undefined) {
    try {
      report = JSON.parse(lastLine);
    } catch {
      report = null;
    }
  }

  // ---- what must never be on disk or in a stream: the token ----
  const leaks = [];
  const scan = (label, text) => {
    if (typeof text === 'string' && text.includes(session.accessToken)) leaks.push(label);
  };
  scan('stdout', stdout);
  scan('stderr', stderr);
  for (const file of listFiles(runDir)) {
    let text;
    try {
      text = readFileSync(file, 'latin1');
    } catch {
      continue;
    }
    scan(file, text);
  }

  const logText = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const browserMarkers = BROWSER_FLOW_MARKERS.filter((pattern) => pattern.test(logText)).map((pattern) => pattern.source);

  return {
    startedAt,
    wallMs,
    status: child.status,
    signal: child.signal ?? null,
    timedOut: child.error?.code === 'ETIMEDOUT',
    spawnError: child.error === undefined ? null : String(child.error.message),
    report,
    exitClass: report?.exitClass ?? (child.status === null ? 'INFRA_ERROR' : 'UNPARSEABLE_OUTPUT'),
    browserFlowEntered: report?.browserFlowEntered === 'true' || browserMarkers.length > 0,
    browserMarkersInLog: browserMarkers,
    tokenLeaks: leaks,
    success: existsSync(successFile) ? readFileSync(successFile, 'utf8') : null,
    error: existsSync(errorFile) ? readFileSync(errorFile, 'utf8') : null,
    logFile,
    logSha256: sha256Of(Buffer.from(logText, 'utf8')),
    stdout,
    stderr,
  };
}

function listFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(absolute);
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

/**
 * Parse a Data Loader success/error CSV the way the runners always have: the
 * first line is the header, quoted fields, one record per line.
 */
export function parseStatusCsv(text) {
  if (text === null || text.trim() === '') return [];
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/).filter((line) => line !== '');
  const parse = (line) => {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const c = line[index];
      if (quoted) {
        if (c === '"' && line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') {
        cells.push(cell);
        cell = '';
      } else cell += c;
    }
    cells.push(cell);
    return cells;
  };
  const header = parse(lines[0] ?? '');
  return lines.slice(1).map((line) => {
    const cells = parse(line);
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']));
  });
}
