const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../api/refinement-maintenance");
test("maintenance endpoint rejects missing/invalid credentials and browser identity overrides before integration access",async()=>{
  const handler=createHandler({kv:{get(){throw Error("unexpected access");}},axios:{},secret:"mock-maintenance-only"});
  async function invoke(headers,body,method="POST"){
    let status=200,data,cache;
    await handler({method,headers,body},{setHeader(k,v){if(k==="Cache-Control")cache=v;},
      status(v){status=v;return this;},json(v){data=v;return this;}});
    return {status,data,cache};
  }
  assert.equal((await invoke({},{})).status,401);
  assert.equal((await invoke({"x-maintenance-secret":"wrong"},{})).status,401);
  const r=await invoke({"x-maintenance-secret":"mock-maintenance-only"},{agent_id:"agent_other",llm_id:"browser"});
  assert.equal(r.status,400);assert.equal(r.cache,"no-store");
  assert.equal((await invoke({},{},"GET")).status,405);
});
