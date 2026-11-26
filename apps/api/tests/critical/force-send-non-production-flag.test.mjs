/**
 * P0 round 4 item 6: dev/force-send calls TextGrid directly, outside every
 * send seam. It must refuse unless the deployment EXPLICITLY declares a
 * non-production environment that permits it, whatever NODE_ENV says.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEV_FORCE_SEND_FLAG,
  DEV_FORCE_SEND_FLAG_VALUE,
  handleDevForceSendRequest,
  isDevForceSendExplicitlyAllowed,
} from "@/app/api/dev/force-send/route.js";

function run(env) {
  const calls = { send: 0, access: 0, warnings: [] };
  const promise = handleDevForceSendRequest(
    { headers: new Headers({ "x-internal-api-secret": "internal-secret" }) },
    {
      env,
      logger: { warn: (event) => calls.warnings.push(event), log: () => {}, error: () => {} },
      requireDevRouteAccess: () => { calls.access += 1; return null; },
      sendTextgridSMS: async () => { calls.send += 1; return { ok: true, sid: "SMforce" }; },
    }
  );
  return promise.then((response) => ({ response, calls }));
}

test("force-send refuses without the flag for every NODE_ENV that is not production (incl. unset)", async () => {
  for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }, { NODE_ENV: "" }, { NODE_ENV: "staging" }]) {
    const { response, calls } = await run(env);
    assert.equal(response.status, 404, JSON.stringify(env));
    assert.equal(calls.send, 0, JSON.stringify(env));
    assert.equal(calls.access, 0, JSON.stringify(env));
    assert.equal(calls.warnings[0], "dev_force_send_blocked_flag_missing");
  }
});

test("force-send refuses a flag that is merely truthy: only the exact declared value counts", async () => {
  for (const value of ["1", "true", "yes", "allow", ` ${DEV_FORCE_SEND_FLAG_VALUE}x`]) {
    assert.equal(isDevForceSendExplicitlyAllowed({ [DEV_FORCE_SEND_FLAG]: value }), false, value);
    const { response, calls } = await run({ NODE_ENV: "development", [DEV_FORCE_SEND_FLAG]: value });
    assert.equal(response.status, 404);
    assert.equal(calls.send, 0);
  }
});

test("force-send refuses in production even with the flag set", async () => {
  for (const env of [
    { NODE_ENV: "production", [DEV_FORCE_SEND_FLAG]: DEV_FORCE_SEND_FLAG_VALUE },
    { NODE_ENV: "development", VERCEL_ENV: "production", [DEV_FORCE_SEND_FLAG]: DEV_FORCE_SEND_FLAG_VALUE },
  ]) {
    const { response, calls } = await run(env);
    assert.equal(response.status, 404);
    assert.equal(calls.send, 0);
    assert.equal(calls.warnings[0], "dev_force_send_blocked_in_production");
  }
});

test("force-send runs only with the explicit non-production flag (and still behind the dev route guard)", async () => {
  const { response, calls } = await run({ NODE_ENV: "development", [DEV_FORCE_SEND_FLAG]: DEV_FORCE_SEND_FLAG_VALUE });
  assert.equal(response.status, 200);
  assert.equal(calls.access, 1);
  assert.equal(calls.send, 1);
});
