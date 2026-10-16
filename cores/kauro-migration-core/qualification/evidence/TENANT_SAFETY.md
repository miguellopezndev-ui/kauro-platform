# Qualification tenants, and why writing to them is safe

Recorded before any write. A credential that works is not evidence that the
account behind it is safe to put synthetic data into, so both were established
read-only first.

## HubSpot

    GET https://api.hubapi.com/account-info/v3/details

    portalId              51872453
    accountType           DEVELOPER_TEST
    dataHostingLocation   na1
    uiDomain              app.hubspot.com

`accountType` is the account's own statement about what it is. A developer test
account is an isolated account created for testing: HubSpot documents that test
accounts cannot sync data with any other account, which is the isolation this
needs. It is not a standard account and cannot be one.

Read-only counts before qualification: 415 contacts, 70 companies, 60 deals —
the sample population a test account carries, not customer data. No property
whose name begins `kauro` existed on contacts, companies or deals, so the
qualification metadata created here is new and identifiable.

Verdict: **case A** — the token already points at an isolated developer test
account. Safe to use.

## Salesforce

    POST {SF_LOGIN_URL}/services/oauth2/token   grant_type=client_credentials

    instance_url          https://orgfarm-e7aa04ef83-dev-ed.develop.my.salesforce.com
    token_type            Bearer
    scope                 api

    SELECT Id, Name, OrganizationType, IsSandbox, InstanceName FROM Organization

    Id                    00Dak000018tvSeEAI
    OrganizationType      Developer Edition
    IsSandbox             false
    InstanceName          USA840

A Developer Edition org is a free, standalone, disposable development org. It is
not a production org and holds no customer tenancy. Read-only counts before
qualification: 68 accounts, 1,510 contacts, 22 leads, 51 opportunities, 0
opportunity contact roles — the Developer Edition sample dataset.

One leftover custom field, `KAURO_Source_Record_ID` on Contact, predates this
work. It is not used by anything here and is left alone.

Verdict: **safe** — Developer Edition, the disposable org type this
qualification is meant to run against.

## Credential handling

The four credentials are read into a restricted directory outside the
repository, loaded into the qualification process environment only, never
written to a log, never passed on a command line, and never committed. They are
deleted when qualification finishes. Their rotation belongs to the separate
legacy cleanup, not here.
