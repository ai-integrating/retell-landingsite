// Dedicated ephemeral Redis, Unix socket only; no host/URL/token accepted.
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawn,execFileSync}=require("node:child_process");
const {randomUUID}=require("node:crypto"),assert=require("node:assert/strict");
const {withLlm,RENEW,RELEASE,GUARDED_SET}=require("../lib/refinement-coordinator");
global.fetch=()=>{throw Error("HTTP forbidden in Redis coordination test");};
for(const name of ["http","https"]) for(const fn of ["request","get"]) require("node:"+name)[fn]=()=>{throw Error("HTTP forbidden");};
async function main(){
 process.umask(0o077);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"lets-go-redis-")),socket=path.join(dir,"redis.sock");
 const prefix=`lets-go-draft-test:${randomUUID()}:`;
 // Identify environment and namespace BEFORE starting the disposable instance.
 console.log(JSON.stringify({environment:"local disposable Redis 7.2; Unix socket only; TCP disabled",socket,namespace:prefix,retell:"mocked",productionKV:false}));
 const server=spawn("redis-server",["--port","0","--unixsocket",socket,"--unixsocketperm","700","--save","","--appendonly","no","--dir",dir],{stdio:"ignore"});
 let startError=false;server.on("error",()=>{startError=true;});
 const command=(...args)=>JSON.parse(execFileSync("redis-cli",["-s",socket,"--json",...args.map(String)],{encoding:"utf8"}));
 const qualify=k=>{assert.ok(k.startsWith("refinement:v1:llm:mock-"));return prefix+k;};
 const kv={
 get:async k=>{const value=command("GET",qualify(k));return value===null?null:JSON.parse(value);},
 set:async(k,v,o={})=>command("SET",qualify(k),typeof v==="string"?v:JSON.stringify(v),...(o.nx?["NX"]:[]),...(o.px?["PX",o.px]:[])),
 eval:async(script,keys,args)=>command("EVAL",script,keys.length,...keys.map(qualify),...args)
 };
 try {
  for(let i=0;i<100&&!fs.existsSync(socket)&&!startError;i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(fs.existsSync(socket));assert.equal(command("PING"),"PONG");
  const lock="refinement:v1:llm:mock-lock:lock",state="refinement:v1:llm:mock-lock:section";
  assert.equal(await kv.set(lock,"owner",{nx:true,px:5000}),"OK");
  assert.equal(await kv.set(lock,"other",{nx:true,px:5000}),null);
  assert.equal(await kv.eval(RENEW,[lock],["wrong",5000]),0);
  assert.equal(await kv.eval(RENEW,[lock],["owner",5000]),1);
  assert.equal(await kv.eval(RELEASE,[lock],["wrong"]),0);
  assert.equal(await kv.eval(GUARDED_SET,[lock,state],["wrong",'{"bad":true}']),0);
  assert.equal(await kv.eval(RELEASE,[lock],["owner"]),1);
  await kv.set(lock,"expired",{nx:true,px:10});await new Promise(r=>setTimeout(r,30));
  await kv.set(lock,"replacement",{nx:true,px:5000});
  assert.equal(await kv.eval(GUARDED_SET,[lock,state],["expired","{}"]),0);
  assert.equal(await kv.eval(RELEASE,[lock],["expired"]),0);
  let prompt="Scheduler: unchanged",patches=0;
  const adapter={kv,llmId:"mock-timeout",getPrompt:async()=>prompt,patchPrompt:async()=>{patches++;throw Error("mock timeout");}};
  await assert.rejects(withLlm(adapter,c=>c.apply("Scheduler: unchanged\nnew",{ok:true})),/mock timeout/);
  await assert.rejects(withLlm(adapter,()=>assert.fail("uncertain write must block")),/UPDATE_OUTCOME_UNRESOLVED/);
  prompt="Scheduler: unchanged\nnew";
  // Fresh coordinator invocation: persisted journal, no process-local retry state.
  await withLlm({...adapter},c=>assert.equal(c.journal.status,"confirmed"));
  assert.equal(patches,1);
  console.log("PASS: NX contention, renew/release fencing, expired-owner fencing, durable uncertainty, delayed-success recovery without duplicate PATCH.");
 } finally {
  // This socket belongs ONLY to the process just created; never flush a shared DB.
  if(fs.existsSync(socket)){try{command("SHUTDOWN","NOSAVE");}catch{}}
  if(server.exitCode===null)server.kill("SIGTERM");
  fs.rmSync(dir,{recursive:true,force:true});
 }
}
main().catch(()=>{console.error("Isolated Redis test failed; no live integrations used.");process.exitCode=1;});
