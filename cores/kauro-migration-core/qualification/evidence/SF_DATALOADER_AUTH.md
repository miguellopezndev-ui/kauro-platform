# How Data Loader authenticated, and how it did not

Recorded because the obvious account of it is wrong, and a gate built on a wrong
account of its own authentication is not evidence of anything.

## What was attempted

Data Loader v67.0.0 (released 2026-06-25, JRE 17 or later; OpenJDK 17.0.18 is
installed) was downloaded from the official release and run in batch mode:

    java -jar dataloader-67.0.0.jar run.mode=batch \
         salesforce.config.dir=<dir> process.name=<bean>

The intent was to authenticate it with the access token obtained by the OAuth
client-credentials flow, which the release does appear to support: `AppConfig`
declares `sfdc.oauth.accesstoken`, and `LoginClient` and `ClientBase` both read
it. Four things had to be got right before it would even start:

- the entry point is `DataLoaderRunner` in batch mode, not `ProcessRunner`,
  which has no `main`;
- `process-conf.xml` must use the Spring **XSD** header, because the 2.0 DTD
  sends Spring to springframework.org and the parse dies offline;
- `sfdc.oauth.accesstoken` is an **encrypted** property — a plain token fails
  while being decrypted, so it must be encrypted with
  `EncryptionUtil -e <value> <keyfile>` and the key named by
  `process.encryptionKeyFile`, not `sfdc.encryptionKeyFile`;
- a Java properties file reads `\` as an escape, so a Windows path written
  literally arrives with its separators eaten.

With all four right, the loader ran and loaded records.

## What actually authenticated it

**Not the token.** The same run succeeds with `sfdc.oauth.accesstoken` removed
from the configuration entirely.

The records it created are owned by `005ak00000fA2c3AAC`
(`miguellopezn.dev...@agentforce.com`), not by `005ak00000fAIk1AAG`
(the org's integration user), which is the user the client-credentials
token runs as. Data Loader is authenticating from a session already saved on this
machine by an earlier, unrelated Data Loader use — an existing local
authentication, which is a legitimate thing to run qualification on, but it is
not the credential this work supplied.

That difference had a visible consequence. Fields created for qualification were
invisible to Data Loader's describe, so every mapping naming one was rejected as
invalid while the same field was writable through REST as the token's user. The
cause was field-level security: the permission set had been assigned to the
token's user and not to the one Data Loader was really running as. Assigning it
to both resolved it, and the upsert then matched on the External ID as expected.

## Why this is recorded rather than smoothed over

Three reasons.

The claim "Data Loader runs headless on a client-credentials token" would have
been false, and it would have been believed, because the loader really did run
headless and really did carry the token in its configuration.

The failure it caused — a valid field reported as an invalid mapping — is exactly
the shape of bug that gets blamed on the wrong component. It was not a Kauro
defect and not a Salesforce defect; it was two different users looking at the
same org.

And it says something the target contract already says in its own terms: a
describe shows what *its* user can see. The engine treats an absent field as *not
established* rather than *does not exist* for this reason, and here is the reason
happening.

## What this does not undermine

The Salesforce target contract is built from describe output captured with the
client-credentials token, by the collector, and that half is unaffected: org
`00Dak000018tvSeEAI`, contract
`tc_b27772aaaab05e6cc912f8d3bd87c52c83d992b1e177454dee7adc3c09a1076c`, which is
`contractHash` in `sf-target-contract.json`.

This line read `tc_86e752ce58ae0660` until now, and that string names nothing in
this tree. It is sixteen characters where a contract hash is sixty-four, so it
was never a whole hash — it was a truncation kept as though it were the value,
and once the contract was recaptured there was nothing left to truncate it from.
A shortened digest is a fine thing to print for a human and a bad thing to store,
because the moment the full value moves, the short one cannot be checked against
anything and quietly stops being wrong in any way a reader can see.
