// An offline model of AWS's policy evaluation, for the authority matrix of Order 25 (VERIFIED_STATIC, never proof of what a real
// account does: AWS's own evaluation, eventual consistency and every service-specific rule are PENDING_PROVIDER). It implements the
// documented logic the guard policies rely on (IAM user guide, "Policy evaluation logic" and "Cross-account policy evaluation
// logic"; AWS Organizations user guide, SCP and RCP evaluation):
//
//   1. an explicit Deny in any applicable policy — SCP, RCP, resource-based, identity-based, permissions boundary — ends it;
//   2. SCPs apply to principals of member accounts (never the management account, never a service-linked role); RCPs apply to
//      resources of member accounts, whoever calls (never to service-linked roles). Both are modelled as deny lists on top of the
//      FullAWSAccess / RCPFullAWSAccess policies AWS attaches, which Kauro keeps;
//   3. same account: an Allow in the identity policies (inside the boundary, if any) or in the resource policy for that principal;
//      across accounts: both;
//   4. otherwise the implicit deny.
//
// Supported: Action/NotAction, Resource/NotResource (ARN segments with * and ?), Principal ("*", AWS account roots and ARNs,
// Service), and the condition operators the documents use, with IfExists and ForAllValues/ForAnyValue. Anything else throws, so a
// document the model cannot read is never judged by accident.

const ARN_SEGMENTS = 6;

function globToRegExp(pattern, caseInsensitive) {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`, caseInsensitive ? "is" : "s");
}

function glob(pattern, value, caseInsensitive = false) {
  return globToRegExp(pattern, caseInsensitive).test(value);
}

function splitArn(arn) {
  const parts = arn.split(":");
  if (parts.length < ARN_SEGMENTS) return null;
  return [...parts.slice(0, ARN_SEGMENTS - 1), parts.slice(ARN_SEGMENTS - 1).join(":")];
}

/** ARN matching as ArnLike and the Resource element do it: segment by segment, wildcards inside a segment. */
export function arnLike(pattern, arn) {
  if (pattern === "*") return true;
  const p = splitArn(pattern);
  const a = splitArn(arn);
  if (!p || !a) return false;
  return p.every((segment, i) => glob(segment, a[i]));
}

function actionMatches(pattern, action) {
  return glob(pattern, action, true);
}

const list = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function matchesAction(statement, action) {
  if (statement.Action !== undefined) return list(statement.Action).some((p) => actionMatches(p, action));
  if (statement.NotAction !== undefined) return !list(statement.NotAction).some((p) => actionMatches(p, action));
  throw new Error(`${statement.Sid}: neither Action nor NotAction`);
}

function matchesResource(statement, resource) {
  if (statement.Resource !== undefined) return list(statement.Resource).some((p) => arnLike(p, resource));
  if (statement.NotResource !== undefined) return !list(statement.NotResource).some((p) => arnLike(p, resource));
  // SCPs and RCPs may omit nothing here; identity policies always carry one of the two.
  throw new Error(`${statement.Sid}: neither Resource nor NotResource`);
}

function matchesPrincipal(statement, principal) {
  if (statement.Principal === undefined) throw new Error(`${statement.Sid}: a resource-based statement without Principal`);
  if (statement.Principal === "*") return true;
  for (const [kind, values] of Object.entries(statement.Principal)) {
    for (const value of list(values)) {
      if (kind === "AWS") {
        if (value === "*") return true;
        if (/^arn:aws:iam::\d{12}:root$/.test(value) || /^\d{12}$/.test(value)) {
          const account = value.match(/\d{12}/)[0];
          if (principal.account === account && principal.type !== "service") return true;
        } else if (principal.arn === value) {
          return true;
        }
      } else if (kind === "Service") {
        if (principal.type === "service" && principal.service === value) return true;
      } else if (kind === "Federated") {
        if (principal.type === "federated" && principal.provider === value) return true;
      } else {
        throw new Error(`${statement.Sid}: principal kind ${kind} is not modelled`);
      }
    }
  }
  return false;
}

// ---- Conditions ----------------------------------------------------------------------------------------------------------------

const NEGATED = new Set(["StringNotEquals", "StringNotEqualsIgnoreCase", "StringNotLike", "ArnNotEquals", "ArnNotLike", "NumericNotEquals"]);

function compare(operator, policyValue, contextValue) {
  const v = String(contextValue);
  const p = String(policyValue);
  switch (operator) {
    case "StringEquals":
    case "StringNotEquals":
      return v === p;
    case "StringEqualsIgnoreCase":
    case "StringNotEqualsIgnoreCase":
      return v.toLowerCase() === p.toLowerCase();
    case "StringLike":
    case "StringNotLike":
      return glob(p, v);
    case "ArnEquals":
    case "ArnNotEquals":
    case "ArnLike":
    case "ArnNotLike":
      return arnLike(p, v);
    case "Bool":
      return v.toLowerCase() === p.toLowerCase();
    case "NumericEquals":
    case "NumericNotEquals":
      return Number(v) === Number(p);
    case "NumericLessThan":
      return Number(v) < Number(p);
    case "NumericLessThanEquals":
      return Number(v) <= Number(p);
    case "NumericGreaterThan":
      return Number(v) > Number(p);
    case "NumericGreaterThanEquals":
      return Number(v) >= Number(p);
    default:
      throw new Error(`condition operator ${operator} is not modelled`);
  }
}

/** One operator over one key, per the IAM user guide's condition rules. */
function evaluateCondition(rawOperator, key, policyValues, context) {
  let operator = rawOperator;
  let setOperator = null;
  const setMatch = /^(ForAllValues|ForAnyValue):(.+)$/.exec(operator);
  if (setMatch) [, setOperator, operator] = setMatch;
  let ifExists = false;
  if (operator.endsWith("IfExists")) {
    ifExists = true;
    operator = operator.slice(0, -"IfExists".length);
  }
  const values = list(policyValues);
  const present = Object.hasOwn(context, key) && context[key] !== undefined;

  if (operator === "Null") {
    // "true": the key must be absent; "false": present.
    return values.some((p) => String(p).toLowerCase() === String(!present));
  }
  if (!present) {
    if (setOperator === "ForAllValues") return true;
    if (ifExists) return true;
    // "If the policy condition requires that the key is not matched, such as StringNotLike or ArnNotLike, and the right key is not
    // present, the condition is true" (IAM user guide, condition operators).
    return NEGATED.has(operator);
  }
  const contextValues = list(context[key]);
  const anyMatch = (cv) => values.some((p) => compare(operator, p, cv));
  if (setOperator === "ForAllValues") return contextValues.every((cv) => (NEGATED.has(operator) ? !anyMatch(cv) : anyMatch(cv)));
  if (setOperator === "ForAnyValue") return contextValues.some((cv) => (NEGATED.has(operator) ? !anyMatch(cv) : anyMatch(cv)));
  if (contextValues.length !== 1) throw new Error(`${key}: a multivalued key needs ForAllValues or ForAnyValue`);
  return NEGATED.has(operator) ? !anyMatch(contextValues[0]) : anyMatch(contextValues[0]);
}

function conditionsHold(statement, context) {
  for (const [operator, keys] of Object.entries(statement.Condition ?? {})) {
    for (const [key, values] of Object.entries(keys)) {
      if (!evaluateCondition(operator, key, values, context)) return false;
    }
  }
  return true;
}

// ---- Policies ------------------------------------------------------------------------------------------------------------------

/** "ALLOW", "DENY" or null (not applicable) for one policy and one request. */
export function policyEffect(policy, request, { resourceBased = false } = {}) {
  let allowed = false;
  for (const statement of policy.Statement) {
    if (resourceBased && !matchesPrincipal(statement, request.principal)) continue;
    if (!matchesAction(statement, request.action)) continue;
    if (!matchesResource(statement, request.resource)) continue;
    if (!conditionsHold(statement, request.context)) continue;
    if (statement.Effect === "Deny") return { effect: "DENY", sid: statement.Sid };
    if (statement.Effect === "Allow") allowed = statement.Sid;
  }
  return allowed ? { effect: "ALLOW", sid: allowed } : null;
}

/**
 * The decision for one request.
 * world: { managementAccountId, orgId, scps: {accountId: [policy]}, rcps: {accountId: [policy]}, resourcePolicyOf(resource) }
 * request: { principal: {arn, account, type, identityPolicies, boundary}, action, resource, resourceAccount, context }
 */
export function evaluate(world, input) {
  const { principal } = input;
  const context = {
    "aws:PrincipalArn": principal.arn,
    "aws:PrincipalAccount": principal.account,
    "aws:PrincipalOrgID": principal.orgId,
    "aws:ResourceAccount": input.resourceAccount,
    "aws:RequestedRegion": "us-east-1",
    "aws:SecureTransport": "true",
    "aws:PrincipalIsAWSService": principal.type === "service" ? "true" : "false",
    ...input.context,
  };
  for (const [key, value] of Object.entries(context)) if (value === undefined) delete context[key];
  const request = { ...input, context };
  const trail = [];
  const deny = (layer, sid) => ({ decision: "DENY", explicit: true, layer, sid, trail });

  const exemptFromOrgPolicies = principal.type === "service-linked" || principal.type === "service";

  // SCPs: the principal's account, if it is a member account.
  if (!exemptFromOrgPolicies && principal.account !== world.managementAccountId) {
    for (const scp of world.scps[principal.account] ?? []) {
      const r = policyEffect(scp, request);
      if (r?.effect === "DENY") return deny("SCP", r.sid);
    }
  }
  // RCPs: the resource's account, if it is a member account.
  if (!exemptFromOrgPolicies && input.resourceAccount !== world.managementAccountId) {
    for (const rcp of world.rcps[input.resourceAccount] ?? []) {
      const r = policyEffect(rcp, request, { resourceBased: true });
      if (r?.effect === "DENY") return deny("RCP", r.sid);
    }
  }
  const resourcePolicy = world.resourcePolicyOf(input.resource);
  const resourceResult = resourcePolicy ? policyEffect(resourcePolicy, request, { resourceBased: true }) : null;
  if (resourceResult?.effect === "DENY") return deny("RESOURCE", resourceResult.sid);

  let identityAllow = null;
  for (const policy of principal.identityPolicies ?? []) {
    const r = policyEffect(policy, request);
    if (r?.effect === "DENY") return deny("IDENTITY", r.sid);
    if (r?.effect === "ALLOW") identityAllow ??= r.sid;
  }
  if (principal.boundary) {
    const r = policyEffect(principal.boundary, request);
    if (r?.effect === "DENY") return deny("BOUNDARY", r.sid);
    if (r?.effect !== "ALLOW") identityAllow = null;
    trail.push(`boundary:${r?.sid ?? "none"}`);
  }

  const sameAccount = principal.account === input.resourceAccount;
  const resourceAllow = resourceResult?.effect === "ALLOW" ? resourceResult.sid : null;
  const allowed = sameAccount ? Boolean(identityAllow || resourceAllow) : Boolean(identityAllow && resourceAllow);
  trail.push(`identity:${identityAllow ?? "none"}`, `resource:${resourceAllow ?? "none"}`, sameAccount ? "same-account" : "cross-account");
  return allowed ? { decision: "ALLOW", trail } : { decision: "DENY", explicit: false, layer: "IMPLICIT", trail };
}
