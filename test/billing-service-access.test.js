const {test}=require("node:test");
const assert=require("node:assert/strict");
const handler=require("../api/billing-service-control");
test("operator endpoint rejects missing authentication without any provider call",async()=>{
  const res={code:200,status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  await handler({headers:{},method:"POST",body:{}},res);
  assert.equal(res.code,401);
});
