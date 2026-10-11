// The pg client and the connection-security check read the variables of PG_ENVIRONMENT_VARIABLES (tls.ts) from process.env.
// Hosted runners export some of them (main 8ba0264: the runner's password variable made the SANDBOX/LIVE cases of apps/control
// refuse by that variable instead of the one under test), so loading the test kit removes them: every test names its host and
// credential. The names live only in tls.ts (DB-TLS-R4: TLS settings belong there; main c8e972b).
import { PG_ENVIRONMENT_VARIABLES } from "../tls.js";

for (const variable of PG_ENVIRONMENT_VARIABLES) delete process.env[variable];
