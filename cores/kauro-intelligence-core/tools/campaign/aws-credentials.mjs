// The campaign's AWS credential source (B04 §4.1, owner decision A9). Temporary credentials only: a session token and an expiry
// are required, so long-term IAM user keys (AKIA…, no session token) are refused. Two sources, in this order:
//   1. the environment: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN and AWS_CREDENTIAL_EXPIRATION (what
//      `aws configure export-credentials --format env` prints after `aws sso login`);
//   2. `aws configure export-credentials --format process [--profile <p>]` (IAM Identity Center / SSO session of the builder).
// Nothing is ever written: the credentials live in this process's memory only, and every error names the step, never a secret.
import { execFileSync } from 'node:child_process';

/** Credentials that expire within this margin are refreshed (or refused) before use. */
const SAFETY_MS = 120_000;
const ACCESS_KEY = /^[A-Z0-9]{16,128}$/u;

const fail = (message) => { throw new Error(`AWS credentials: ${message}`); };

function temporary(accessKeyId, secretAccessKey, sessionToken, expiration, now, source) {
  if (typeof accessKeyId !== 'string' || !ACCESS_KEY.test(accessKeyId)) return fail(`${source} gives no access key id of the AWS alphabet`);
  if (typeof secretAccessKey !== 'string' || secretAccessKey === '') return fail(`${source} gives no secret access key`);
  if (typeof sessionToken !== 'string' || sessionToken === '') return fail(`${source} gives no session token: long-term keys are refused, use temporary credentials (aws sso login)`);
  const expires = typeof expiration === 'string' ? Date.parse(expiration) : Number.NaN;
  if (Number.isNaN(expires)) return fail(`${source} gives no expiry: temporary credentials carry one`);
  if (expires - SAFETY_MS <= now) return fail(`${source} gives credentials that are expired or expire within two minutes`);
  return { accessKeyId, secretAccessKey, sessionToken, expiresAt: new Date(expires).toISOString() };
}

/**
 * @param {{ env?: Record<string, string | undefined>, profile?: string, exec?: (command: string, args: string[]) => string, now?: () => number }} options
 * @returns {() => Promise<{ accessKeyId: string, secretAccessKey: string, sessionToken: string, expiresAt: string }>}
 */
export function awsCredentialProvider(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const exec = options.exec ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, shell: process.platform === 'win32' }));
  if (options.profile !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/u.test(options.profile)) fail('the profile name is not a plain AWS profile name');
  let cached = null;
  return async () => {
    if (cached !== null && Date.parse(cached.expiresAt) - SAFETY_MS > now()) return cached;
    if (env.AWS_ACCESS_KEY_ID !== undefined && env.AWS_ACCESS_KEY_ID !== '') {
      cached = temporary(env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN, env.AWS_CREDENTIAL_EXPIRATION, now(), 'the environment');
      return cached;
    }
    const args = ['configure', 'export-credentials', '--format', 'process', ...(options.profile === undefined ? [] : ['--profile', options.profile])];
    let text;
    try { text = exec('aws', args); } catch (error) { return fail(`aws configure export-credentials failed (${error instanceof Error ? error.name : 'error'}); run aws sso login first`); }
    let parsed;
    try { parsed = JSON.parse(text); } catch { return fail('aws configure export-credentials did not print JSON'); }
    if (parsed === null || typeof parsed !== 'object' || parsed.Version !== 1) return fail('aws configure export-credentials did not print the process format (Version 1)');
    cached = temporary(parsed.AccessKeyId, parsed.SecretAccessKey, parsed.SessionToken, parsed.Expiration, now(), 'aws configure export-credentials');
    return cached;
  };
}
