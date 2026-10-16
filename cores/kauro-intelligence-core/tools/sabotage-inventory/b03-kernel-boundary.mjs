/**
 * Sabotage inventory — the B03-KERNEL-BOUNDARY lot: the strict reader
 * (D3-PARSE-1), the raw-body decoder (D3-PARSE-2), the two windows
 * (D3-TIME-1), the declared identity (D3-ID-1) and the public projection
 * with its closed codes (D3-PRIV-1). Each mutation breaks one rule inside the
 * code that enforces it; test/b03-kernel-boundary.test.ts (and, for the
 * request-payload guard, test/transport-f05.test.ts) must kill it. Same shape
 * as core.mjs; ids are unique across the directory.
 */
export const MUTATIONS = [
  // D3-PARSE-1: a repeated member name grants nothing.
  { id: 'duplicate-key-check-removed', file: 'src/contracts/schema.ts', from: "        if (seen.has(name)) problems.push({ pointer: memberPointer, code: 'DUPLICATE_KEY', message: 'a member name the object already holds' });", to: '        /* sabotage */', gate: 'a proposal that repeats requiresAgencyDecision, true then false, is read last-member-wins and the item drafts' },
  { id: 'payload-guard-not-strict', file: 'src/gateway/transport-gateway.ts', from: "  const wire: unknown = strictly(typeof request === 'string' ? request : JSON.stringify(request), 'body');", to: "  const wire: unknown = JSON.parse(typeof request === 'string' ? request : JSON.stringify(request));", gate: 'the request-payload guard reads a repeated member last-member-wins' },
  // D3-PARSE-2: a raw body is decoded fatally, and an early end is ambiguous.
  { id: 'decoder-made-non-fatal', file: 'src/gateway/transport-gateway.ts', from: "  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });", to: "  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });", gate: 'an invalid UTF-8 sequence becomes a replacement character and the answer drafts' },
  { id: 'early-end-billed-as-malformed', file: 'src/gateway/transport-gateway.ts', from: "  if (problems.some((problem) => problem.code === 'TRUNCATED')) return failed('AMBIGUOUS', RAW_BODY_REASONS.EARLY_END);", to: '  /* sabotage */', gate: 'a body cut before its end is a malformed answer instead of an ambiguous dispatch' },
  // D3-TIME-1: two windows; the resource profile only shortens the semantic one.
  { id: 'absolute-deadline-read-from-semantic', file: 'src/kernel/ledger.ts', from: '      absoluteDeadlineAt: created.absoluteDeadlineAt,', to: '      absoluteDeadlineAt: created.semanticDeadlineAt,', gate: 'a Migration Core validation that returns after the twenty-minute window and inside the audit window is never promoted' },
  { id: 'wall-clock-extends-window', file: 'src/kernel/ledger.ts', from: '    const window = Math.min(bounded(input.wallClockMs), BUDGET_LIMITS.MAX_INTELLIGENCE_WALL_CLOCK_MS);', to: '    const window = input.wallClockMs ?? BUDGET_LIMITS.MAX_INTELLIGENCE_WALL_CLOCK_MS;', gate: 'a resource profile of twenty-five hours extends the semantic window past the policy' },
  { id: 'resource-profile-above-policy-accepted', file: 'src/api/intelligence-core.ts', from: "    else if (windowMs !== undefined && windowMs > BUDGET_LIMITS.MAX_INTELLIGENCE_WALL_CLOCK_MS) hostProblems.push('RESOURCE_PROFILE_ABOVE_POLICY');", to: '    /* sabotage */', gate: 'a resource profile above the twenty-minute policy runs and spends instead of failing its contract' },
  { id: 'host-absolute-deadline-ignored', file: 'src/kernel/ledger.ts', from: '    const absolute = Math.min(startMs + ABSOLUTE_WINDOW_MS, bounded(input.absoluteDeadlineMs));', to: '    const absolute = startMs + ABSOLUTE_WINDOW_MS;', gate: 'the audit\'s own absolute deadline is ignored and a run is promoted after it' },
  { id: 'host-interpretation-deadline-ignored', file: 'src/kernel/ledger.ts', from: '    const semantic = Math.min(startMs + window, bounded(input.interpretationDeadlineMs), absolute);', to: '    const semantic = Math.min(startMs + window, absolute);', gate: 'the audit\'s interpretation deadline is ignored and requests are dispatched after it' },
  { id: 'expired-audit-worked', file: 'src/api/intelligence-core.ts', from: "    if (ledger.absoluteDeadlinePassed()) {\n      ledger.note('absolute deadline passed before the run finished', { events: opened.events });", to: "    if (ledger.absoluteDeadlinePassed() && opened.events < 0) {\n      ledger.note('absolute deadline passed before the run finished', { events: opened.events });", gate: 'a run opened after the audit\'s absolute deadline goes on working instead of ending DEADLINE_EXCEEDED' },
  // D3-ID-1: every declared member binds the attempt.
  { id: 'identity-member-unbound', file: 'src/api/intelligence-core.ts', from: '      for (const [member, inner] of Object.entries(form as Record<string, unknown>)) bound[', to: "      for (const [member, inner] of Object.entries(form as Record<string, unknown>).filter(([key]) => key !== 'recordIdColumns')) bound[", gate: 'a finished attempt redelivered with other recordIdColumns is answered from the stored result' },
  // D3-PRIV-1: the public projection and closed codes.
  { id: 'projection-returns-raw-response', file: 'src/kernel/ledger.ts', from: '  const { response, ...kept } = event;', to: '  const { ...kept } = event;\n  const response: unknown = event.response;', gate: 'the provider\'s answer, and whatever it echoed, is in result.runLedger and readRun' },
  { id: 'schema-problem-text-recorded', file: 'src/api/intelligence-core.ts', from: '        const codes = [...parsed.codes.slice(0, 16), ...call.codes];', to: '        const codes = [...parsed.problems.slice(0, 16).map((problem) => `${problem.pointer}:${problem.message}`), ...call.codes];', gate: 'schema problems are recorded with the member names and values the model wrote' },
  { id: 'schema-pointer-not-closed', file: 'src/contracts/schema.ts', from: "      kept.push('*');\n      shape = null;", to: '      kept.push(segment);\n      shape = null;', gate: 'the name of a member the model invented is recorded in the pointer of its code' },
  { id: 'model-param-name-recorded', file: 'src/compiler/compiler.ts', from: '    return KNOWN_PARAM_CODES.has(code.slice(prefix.length + 1)) ? code : prefix;', to: '    return code;', gate: 'a parameter name the model invented is recorded in the task codes' },
];
