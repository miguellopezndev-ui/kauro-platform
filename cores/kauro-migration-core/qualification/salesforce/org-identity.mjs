/**
 * Which org a qualification actually touched, asked of the credential.
 *
 * Every Salesforce evidence file used to carry the org id as a string literal:
 *
 *     orgId: '00Dak000018tvSeEAI',
 *
 * which is a constant wearing a capture's clothes. It happened to be right. It
 * would have gone on being right-looking after the credential was repointed at
 * any other org, and the evidence would then have named an org nobody had
 * touched — which is the failure the HubSpot side actually suffered, where the
 * import evidence recorded portal 51050101 while every record it created went to
 * 51872453.
 *
 * The third harness took the org from the *contract* instead, which is the same
 * mistake by a longer route: a contract describes the org it was captured from,
 * not the org a run writes to, and those coincide only by luck.
 *
 * So the org states what it is, over the same session the qualification uses,
 * and the answer is recorded together with where it came from. A reader who
 * cannot tell a derived fact from a typed one has no way to audit either.
 */

/**
 * Ask the session who it is.
 *
 * `sf` is the caller's own request helper, so the identity comes over exactly
 * the session the qualification runs on rather than a second one that might
 * authenticate somewhere else. Two calls rather than one: `userinfo` states the
 * organization id, and the `Organization` record states what kind of org it is
 * and whether it is a sandbox. The second matters for the tenant-safety record —
 * "no customer data" is a claim about a specific org, and an evidence file that
 * does not say which kind of org it wrote to cannot support it.
 */
export function establishOrg(sf) {
  // `sf` here is the caller's helper in its own shape: it returns the parsed
  // body and throws on anything that is not a 2xx, which both Salesforce
  // runners already do. Nothing about the status handling is repeated here,
  // because a second opinion about what counts as an error is how two callers
  // come to disagree about whether a run succeeded.
  const identity = sf('GET', '/services/oauth2/userinfo');
  if (typeof identity?.organization_id !== 'string') {
    throw new Error('GET /services/oauth2/userinfo carried no organization_id; the org being written to could not be established');
  }
  const orgId = identity.organization_id;

  const org = sf('GET', '/services/data/v67.0/query?q=SELECT+Id,Name,OrganizationType,IsSandbox+FROM+Organization');
  const record = org?.records?.[0] ?? null;
  if (record === null) {
    throw new Error('querying Organization returned no record; what kind of org this is could not be established');
  }
  if (record.Id !== orgId) {
    // Not a hypothetical: the two answers come from different endpoints and a
    // session that had been swapped underneath the run would show it here.
    throw new Error(`userinfo states org ${orgId} and the Organization record states ${String(record.Id)}`);
  }

  return {
    orgId,
    orgIdSource: 'GET /services/oauth2/userinfo on the credential this qualification ran on, in this run',
    organizationType: String(record.OrganizationType ?? ''),
    isSandbox: record.IsSandbox === true,
  };
}

/**
 * Refuse to record a result whose contract describes a different org.
 *
 * The same rule the HubSpot import gate now enforces, and for the same reason: a
 * qualification whose contract describes one instance while its writes land in
 * another is not qualifying the engine against a target. It is qualifying it
 * against two, and whichever way the result came out it would not mean what it
 * says.
 */
export function assertContractIsForThisOrg(org, contractOrgId) {
  if (contractOrgId !== org.orgId) {
    throw new Error(
      `REFUSED: the credential writes to org ${org.orgId} (${org.organizationType}) but the contract describes org ${contractOrgId}. ` +
        'Capture a contract from the org being qualified, or point the credential at the org the contract describes.',
    );
  }
}

/**
 * The identity fields an evidence file carries, named for what each one is.
 *
 * Spread into the evidence object rather than assembled by each caller, so the
 * three gates cannot drift into describing the same org three different ways.
 */
export function orgEvidenceFields(org) {
  return {
    orgId: org.orgId,
    orgIdSource: org.orgIdSource,
    organizationType: org.organizationType,
    isSandbox: org.isSandbox,
  };
}
