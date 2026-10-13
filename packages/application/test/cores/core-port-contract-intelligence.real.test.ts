// B05 T04 against the real Intelligence adapter (core 0.6.0, evidence class EXECUTED_LOCAL; gateway and admission SIMULATED).
import { after, test } from "node:test";
import { INTELLIGENCE_PORT_CONTRACT, type IntelligencePortBackend } from "../../src/testing/cores.js";
import { fixture, interpretRequest, planRequest, type Fixture } from "./intelligence-support.js";

const made: Fixture[] = [];
after(() => {
  for (const f of made) f.dispose();
});

const backend: IntelligencePortBackend = {
  world() {
    const f = fixture();
    made.push(f);
    return Promise.resolve({
      port: f.adapter,
      plan: planRequest(f),
      request: (manifest, fundedCeilingCents) => interpretRequest(f, manifest, { fundedCeilingCents }),
      dispatches: () => f.gateway.requests.length,
    });
  },
};

for (const c of INTELLIGENCE_PORT_CONTRACT) {
  test(`${c.id} ${c.title.replace("<B>", "intelligence adapter")}`, () => c.run(backend));
}
