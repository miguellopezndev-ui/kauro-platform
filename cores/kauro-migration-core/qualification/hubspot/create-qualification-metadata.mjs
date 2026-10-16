#!/usr/bin/env node
// Creates the custom properties HSP-TARGET-01 needs, and removes them again.
//
// Two properties per object: one the portal is told must hold unique values, and
// one enumeration with a closed set of options. The first is the point — a
// unique custom property is the only thing that can answer "does a property Kauro
// creates behave like one HubSpot ships", and every other part of that gate was
// established on `email`, which HubSpot defines.
//
// `--remove` archives them again. This runs against an account the owner
// authorised that holds their real records, so the qualification leaves nothing
// of its own behind: what it creates, it removes.
//
// Usage:
//   node create-qualification-metadata.mjs --auth <dir> [--remove] [--evidence <file>]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const authDir = argument('--auth');
if (authDir === null) {
  process.stderr.write('usage: node create-qualification-metadata.mjs --auth <dir> [--remove] [--evidence <file>]\n');
  process.exit(2);
}
const remove = process.argv.includes('--remove');
const evidencePath = argument('--evidence');

const shPath = (...parts) => join(...parts).split('\\').join('/');

function hs(method, path, body) {
  const args = [shPath(resolve(authDir), 'hs.sh'), method, path];
  if (body !== undefined) args.push(JSON.stringify(body));
  const out = execFileSync('bash', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/) ?? [])[1] ?? 0);
  const text = out.split('\n__HTTP_STATUS__')[0];
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status, json, text };
}

const OBJECTS = [
  ['contacts', 'contactinformation'],
  ['companies', 'companyinformation'],
  ['deals', 'dealinformation'],
];

const KEY = 'kauro_qualification_key';
const STATUS = 'kauro_qualification_status';

const account = hs('GET', '/account-info/v3/details');
const portalId = String(account.json?.portalId ?? '');
const accountType = String(account.json?.accountType ?? '');

const actions = [];

for (const [objectType, group] of OBJECTS) {
  if (remove) {
    for (const name of [KEY, STATUS]) {
      const response = hs('DELETE', `/crm/v3/properties/${objectType}/${name}`);
      actions.push({ objectType, name, action: 'ARCHIVED', status: response.status });
    }
    continue;
  }

  const existing = hs('GET', `/crm/v3/properties/${objectType}/${KEY}`);
  if (existing.status === 200) {
    actions.push({ objectType, name: KEY, action: 'ALREADY_PRESENT', hasUniqueValue: existing.json?.hasUniqueValue ?? null });
  } else {
    const created = hs('POST', `/crm/v3/properties/${objectType}`, {
      name: KEY,
      label: 'Kauro Qualification Key',
      type: 'string',
      fieldType: 'text',
      groupName: group,
      description: 'Synthetic qualification key created by Kauro qualification. Not customer data. Removed when the run ends.',
      hasUniqueValue: true,
    });
    actions.push({
      objectType,
      name: KEY,
      action: created.status === 201 ? 'CREATED' : 'FAILED',
      status: created.status,
      hasUniqueValue: created.json?.hasUniqueValue ?? null,
      detail: created.status === 201 ? null : created.text.slice(0, 240),
    });
  }

  const status = hs('GET', `/crm/v3/properties/${objectType}/${STATUS}`);
  if (status.status === 200) {
    actions.push({ objectType, name: STATUS, action: 'ALREADY_PRESENT' });
  } else {
    const created = hs('POST', `/crm/v3/properties/${objectType}`, {
      name: STATUS,
      label: 'Kauro Qualification Status',
      type: 'enumeration',
      fieldType: 'select',
      groupName: group,
      description: 'Synthetic qualification status created by Kauro qualification. Not customer data. Removed when the run ends.',
      options: [
        { label: 'READY', value: 'READY', displayOrder: 0, hidden: false },
        { label: 'BLOCKED', value: 'BLOCKED', displayOrder: 1, hidden: false },
      ],
    });
    actions.push({
      objectType,
      name: STATUS,
      action: created.status === 201 ? 'CREATED' : 'FAILED',
      status: created.status,
      detail: created.status === 201 ? null : created.text.slice(0, 240),
    });
  }
}

const failures = actions.filter((entry) => entry.action === 'FAILED');
const evidence = {
  gate: 'HSP-TARGET-01 (qualification metadata)',
  portalId,
  accountType,
  mode: remove ? 'REMOVE' : 'CREATE',
  actions,
  result: failures.length === 0 ? 'PASS' : 'FAIL',
};
if (evidencePath !== null) writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

process.stdout.write(`portal ${portalId} (${accountType}) — ${remove ? 'removing' : 'creating'}\n`);
for (const entry of actions) {
  process.stdout.write(`  ${entry.action.padEnd(15)} ${entry.objectType}.${entry.name}${entry.hasUniqueValue === true ? ' (unique)' : ''}${entry.detail ? ` — ${entry.detail}` : ''}\n`);
}
process.stdout.write(`result = ${evidence.result}\n`);
if (failures.length > 0) process.exitCode = 1;
