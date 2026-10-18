// Explicitly authorized one-shot test. Not a server route or global feature flag.
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {createRequire}=require("node:module");
const {createClient}=require("@vercel/kv");
const {createHandler}=require("../api/refinement");
const {RENEW,RELEASE,GUARDED_SET}=require("../lib/refinement-coordinator");
const {pages}=require("../lib/retell-ownership");
const {plan,TARGET}=require("./lets-go-prepare.cjs");
const {hash,FIELDS,range}=require("../lib/refinement-section");
const root=`refinement:v1:llm:${TARGET.llm}`,mapping=`agent:${TARGET.agent}:client`;
const dir="/home/runner/workspace/.local/private-preflight/lets-go-revision-1";
const base="https://api.retellai.com";
let patches=0,stage="initial",kvWrites=0;
const audit={};
async function main(){
  assert.equal(process.argv[2],"--authorized-draft-and-replay");
  process.umask(0o077);
  for(const [file,flag] of [
    [path.resolve(__dirname,"../api/refinement.js"),"SECTION_REPLACEMENT_ENABLED"],
    ["/home/runner/workspace/artifacts/api-server/src/lib/business-agent-sync.ts","BUSINESS_AGENT_SYNC_ENABLED"],
  ]) assert.ok(fs.readFileSync(file,"utf8").includes(`${flag} = false`));
  const recovery=JSON.parse(fs.readFileSync(dir+"/recovery.json"));
  const request=JSON.parse(fs.readFileSync(dir+"/request.json"));
  assert.equal(request.revision,1);
  assert.equal(request.snapshot_hash,"3e00e84bdd3c34f944ce3a15bba4dd18a59d5520f09d9a6a531335f39a2f278c");
  const proposed=plan(recovery,request);
  assert.equal(proposed.before,fs.readFileSync(dir+"/before.txt","utf8"));
  assert.equal(proposed.after,fs.readFileSync(dir+"/after.txt","utf8"));
  const pg=createRequire("/home/runner/workspace/lib/db/package.json")("pg");
  const db=new pg.Client({connectionString:process.env.DATABASE_URL});
  await db.connect();
  async function databaseCheck(){
    await db.query("BEGIN READ ONLY");
    try {
      const c=(await db.query("SELECT to_jsonb(c) AS data FROM clients c WHERE id=$1",[27])).rows[0]?.data;
      assert.equal(c.config_client_id,TARGET.client);assert.equal(c.agent_id,TARGET.agent);
      assert.equal(c.scheduler_agent_id,TARGET.agent);assert.equal(c.is_active,true);assert.equal(c.portal_access_disabled,false);
      const s=(await db.query("SELECT to_jsonb(s) AS data FROM business_agent_sync s WHERE client_id=$1",[27])).rows[0]?.data;
      assert.equal(s.saved_revision,1);assert.equal(s.snapshot_hash,request.snapshot_hash);
      assert.deepEqual(s.snapshot,request.business_information);
      assert.equal(hash(JSON.stringify(Object.fromEntries(FIELDS.map(k=>[k,s.snapshot[k]])))),s.snapshot_hash);
      const users=(await db.query("SELECT to_jsonb(u) AS data FROM users u WHERE client_id=$1 ORDER BY id",[27])).rows.map(x=>x.data);
      // Comparison stays in memory; never print user records or password hashes.
      return {c,s,users};
    } finally {await db.query("ROLLBACK");}
  }
  try {
    const originalDb=await databaseCheck();stage="coordination preflight";
    const raw=createClient({url:process.env.KV_REST_API_URL,token:process.env.KV_REST_API_TOKEN,retry:false,enableAutoPipelining:false});
    const allowed=new Set([`${root}:lock`,`${root}:journal`,`${root}:section`,`${root}:publication`]);
    const kv={
      get:async key=>{assert.ok(key===mapping||allowed.has(key));return raw.get(key);},
      set:async(key,value,options)=>{assert.equal(key,`${root}:lock`);assert.deepEqual(options,{nx:true,px:60000});kvWrites++;return raw.set(key,value,options);},
      eval:async(script,keys,args)=>{
        assert.equal(keys[0],`${root}:lock`);
        if(script===RENEW||script===RELEASE)assert.equal(keys.length,1);
        else {assert.equal(script,GUARDED_SET);assert.equal(keys.length,2);assert.ok([`${root}:journal`,`${root}:section`].includes(keys[1]));}
        kvWrites++;return raw.eval(script,keys,args);
      }
    };
    assert.equal(await kv.get(mapping),TARGET.client);
    for(const key of allowed)assert.equal(await kv.get(key),null,"EXISTING_COORDINATION_RECORD");
    async function transport(method,url,data,options={}){
      const u=new URL(url);assert.equal(u.origin,base);
      for(const [k,v] of Object.entries(options.params||{}))u.searchParams.set(k,String(v));
      if(method==="GET")assert.match(u.pathname,/^\/(get-agent|get-chat-agent|get-retell-llm|list-agent-versions)\/[A-Za-z0-9_-]+$/);
      else if(method==="POST"){assert.equal(u.pathname,"/v2/list-agents");assert.deepEqual(data,{});}
      else {assert.equal(method,"PATCH");assert.equal(u.pathname,`/update-retell-llm/${TARGET.llm}`);assert.deepEqual(data,{general_prompt:proposed.after});}
      const response=await fetch(u,{method,redirect:"error",signal:AbortSignal.timeout(20000),
        headers:{Authorization:`Bearer ${process.env.RETELL_API_KEY}`,...(method!=="GET"?{"Content-Type":"application/json"}:{})},
        ...(method!=="GET"?{body:JSON.stringify(data)}:{})});
      if(!response.ok)throw Error(`RETELL_HTTP_${response.status}`);
      return {data:await response.json()};
    }
    const get=(url,options)=>transport("GET",url,null,options);
    const readAgent=async()=> (await get(`${base}/get-agent/${TARGET.agent}`)).data;
    const readLlm=async()=> (await get(`${base}/get-retell-llm/${TARGET.llm}`)).data;
    const initialVersions=await pages({get},`${base}/list-agent-versions/${TARGET.agent}`,{});
    assert.equal(initialVersions.length,1);assert.equal(initialVersions[0].version,0);
    async function baseline(){
      assert.deepEqual(await readAgent(),recovery.agent);
      assert.deepEqual(await readLlm(),recovery.llm);
      assert.equal(await kv.get(mapping),TARGET.client);
      assert.deepEqual(await databaseCheck(),originalDb);
    }
    stage="live baseline";await baseline();
    const axios={get,post:(u,b,o)=>transport("POST",u,b,o),
      patch:async(u,b,o)=>{
        assert.equal(patches,0,"SECOND_PATCH_FORBIDDEN");
        stage="immediately-before-patch";await baseline();
        assert.ok(await kv.get(`${root}:lock`));
        const intent=await kv.get(`${root}:journal`);
        assert.equal(intent?.status,"uncertain");assert.equal(intent.targetHash,hash(proposed.after));
        assert.equal(await kv.get(`${root}:publication`),null);
        patches++;stage="patch-dispatched";
        return transport("PATCH",u,b,o);
      }};
    // Factory enabled ONLY inside this fixed-target CLI; global flag remains false.
    const localSecret=randomUUID();
    const handler=createHandler({axios,kv,apiKey:process.env.RETELL_API_KEY,secret:localSecret,enableSection:true});
    async function invoke(){
      assert.equal(request.client_id,TARGET.client);assert.equal(request.agent_id,TARGET.agent);assert.equal(request.publish,false);
      let status=200,result;
      const res={setHeader(){},status(n){status=n;return this;},json(b){result=b;return this;},send(){throw Error("UNEXPECTED_RESPONSE");}};
      await handler({method:"POST",headers:{"x-refinement-secret":localSecret},body:structuredClone(request)},res);
      assert.equal(status,200,"SECTION_OPERATION_FAILED");
      assert.equal(result.llm_id,TARGET.llm);assert.equal(result.state,"draft");assert.equal(result.published,false);
      return result;
    }
    async function verify(){
      const agent=await readAgent(),llm=await readLlm();
      assert.equal(agent.is_published,false);assert.equal(llm.is_published,false);
      assert.equal(llm.general_prompt,proposed.after);
      const metadata=["last_modification_timestamp"];
      function configuration(x){const y=structuredClone(x);for(const k of metadata)delete y[k];return y;}
      assert.deepEqual(configuration(agent),configuration(recovery.agent));
      const expected={...recovery.llm,general_prompt:proposed.after};
      assert.deepEqual(configuration(llm),configuration(expected));
      assert.equal(llm.general_prompt.slice(0,proposed.before.length),proposed.before);
      assert.ok(range(llm.general_prompt)); // also rejects duplicated markers
      const versions=await pages({get},`${base}/list-agent-versions/${TARGET.agent}`,{});
      assert.equal(versions.length,1);assert.equal(versions[0].version,0);
      assert.deepEqual(await databaseCheck(),originalDb);
      assert.equal(await kv.get(mapping),TARGET.client);
      return {agent,llm};
    }
    stage="first operation";audit.firstReceipt=await invoke();
    stage="first verification";await verify();assert.equal(patches,1);
    stage="identical replay";audit.replayReceipt=await invoke();
    assert.deepEqual(audit.firstReceipt,audit.replayReceipt);assert.equal(patches,1);
    stage="final verification";const final=await verify();
    assert.equal((await kv.get(`${root}:journal`)).status,"confirmed");
    assert.equal((await kv.get(`${root}:section`)).revision,1);
    assert.equal(await kv.get(`${root}:lock`),null);
    assert.equal(await kv.get(`${root}:publication`),null);
    fs.writeFileSync(dir+"/post-test-private.json",JSON.stringify(final),{mode:0o600});
    audit.passed=true;audit.patchAttempts=patches;audit.replayPatchAttempts=0;audit.kvWriteCalls=kvWrites;
    audit.publishedVersions=0;audit.protectedDatabaseRecordsUnchanged=true;
    audit.operatorManagedPause=true;
    fs.writeFileSync(dir+"/draft-test-result.json",JSON.stringify(audit,null,2),{mode:0o600});
    console.log(JSON.stringify(audit));
  } finally {await db.end();}
}
main().catch(error=>{
  const report={passed:false,stage,patchAttempts:patches,kvWriteCalls:kvWrites,reason:/^RETELL_HTTP_\d+$/.test(error.message)?error.message:"PRECONDITION_OR_VERIFICATION_FAILED"};
  fs.writeFileSync(dir+"/draft-test-blocker.json",JSON.stringify(report),{mode:0o600});
  console.log(JSON.stringify(report));process.exitCode=1;
});
