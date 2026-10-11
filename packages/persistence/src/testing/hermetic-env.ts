// The pg client and the connection-security check (tls.ts) read PGPASSWORD, PGPASSFILE, PGSSLMODE, PGHOST and PGHOSTADDR from
// process.env. Hosted runners export some of them (main 8ba0264: PGPASSWORD made the SANDBOX/LIVE cases of apps/control refuse by
// that variable instead of the one under test), so loading the test kit removes them: every test names its host and credential.
for (const variable of ["PGPASSWORD", "PGPASSFILE", "PGSSLMODE", "PGHOST", "PGHOSTADDR"]) delete process.env[variable];
export {};
