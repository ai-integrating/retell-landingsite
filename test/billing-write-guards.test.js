const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
test("enabled admission rejects explicit agent and phone overrides; no hold preserves service",async()=>{
 const holds=new Map([["billing:test:hold:outbound:explicit-agent",{}],["billing:test:hold:phone_outbound:test-number",{}]]);
 const sandbox={module:{exports:{}},require:n=>n==="@vercel/kv"?{kv:{get:async k=>holds.get(k)}}:require(n)};
 // Evaluate exact module with ONLY isolated enablement changed.
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../lib/billing-cancellation.js"),"utf8")
 .replace("const ENABLED = false;","const ENABLED = true;"),sandbox);
 for(const [kind,target] of [["outbound","explicit-agent"],["phone_outbound","test-number"]])
 await assert.rejects(sandbox.module.exports.assertAllowed(kind,target),/SUSPENDED/);
 await sandbox.module.exports.assertAllowed("outbound","shared");
 holds.set("billing:test:hold:booking:test-agent",{});
 await assert.rejects(sandbox.module.exports.assertAllowed("booking","test-agent"),/SUSPENDED/);
});
test("all discovered booking and routing writers retain billing checks before dispatch",()=>{
 for(const [file,needle,write] of [
 ["api/cal-strengthened.js",'assertAllowed("booking", ctx.agentId)',"const bookingUrl"],
 ["lib/onboarding-business.js",'assertAllowed("phone_writes", body.phone_number)',"await axios.patch(`${base}/update-phone-number"],
 ["lib/mcduffy-baseline.js",'assertAllowed("phone_writes",phone_number)',"await axios.patch(`${base}/update-phone-number"],
 ["api/outgoing-call.js",'assertAllowed("outbound", agent_id)',"await axios.post"],
 ]){
 const source=fs.readFileSync(path.join(__dirname,"..",file),"utf8");
 const i=source.indexOf(needle);assert.ok(i>=0,file);assert.ok(source.indexOf(write,i)>i,file);
 }
});
test("actual outgoing-call handler rejects overrides before provider dispatch and allows unheld service",async()=>{
 const holds=new Map(),kv={get:async k=>holds.get(k)};let dispatches=0;
 const billing={module:{exports:{}},require:n=>n==="@vercel/kv"?{kv}:require(n)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../lib/billing-cancellation.js"),"utf8")
 .replace("const ENABLED = false;","const ENABLED = true;"),billing);
 const sandbox={module:{exports:{}},process:{env:{RETELL_API_KEY:"synthetic-not-a-credential"}},
 require:n=>n==="axios"?{post:async()=>{dispatches++;return {data:{call_id:"synthetic"}};}}:
 n==="@vercel/kv"?{kv}:n==="../lib/billing-cancellation"?billing.module.exports:
 n==="../lib/versioned-outbound"?{outboundVersion:async()=>0}:require(n)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../api/outgoing-call.js"),"utf8"),sandbox);
 const req={method:"POST",body:{agent_id:"explicit-agent",override_agent_version:0,
 from_number:"+15550001111",to_number:"+15550002222"}};
 const run=async()=>{const res={setHeader(){},end(s){this.body=JSON.parse(s);}};
 await sandbox.module.exports(req,res);return res;};
 holds.set("billing:test:hold:outbound:explicit-agent",{});
 assert.match((await run()).body.error,/SUSPENDED/);assert.equal(dispatches,0);
 holds.clear();holds.set("billing:test:hold:phone_outbound:+15550001111",{});
 assert.match((await run()).body.error,/SUSPENDED/);assert.equal(dispatches,0);
 holds.clear();assert.equal((await run()).statusCode,200);assert.equal(dispatches,1);
});
