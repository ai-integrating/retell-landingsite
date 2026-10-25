const {test}=require("node:test"),a=require("node:assert/strict");
const {createScan,read,retryAfter}=require("../lib/ownership-read-retry");
const {pages,verifyOwnership}=require("../lib/retell-ownership");
const limited=(headers={})=>Object.assign(Error("rate limited"),{response:{status:429,headers}});
function clock(){
 let t=0;const waits=[];
 const scan=createScan({now:()=>t,wallNow:()=>Date.UTC(2026,0,1)+t,random:()=>0,
 sleep:async ms=>{waits.push(ms);t+=ms;}});
 return{scan,waits,advance:ms=>{t+=ms}};
}
test("429 recovers honoring Retry-After seconds and exact version query",async()=>{
 const c=clock();let calls=0;
 const axios={get:async(u,o)=>{a.equal(o.params.version,7);if(calls++===0)throw limited({"retry-after":"2"});return{data:{version:7}}}};
 a.equal((await read(axios,"get","https://mock/get-agent/agent_a",{params:{version:7}},c.scan)).data.version,7);
 a.deepEqual(c.waits,[2000]);a.equal(calls,2);
});
test("HTTP-date Retry-After is honored; malformed header falls back to capped jitter",async()=>{
 const c=clock();
 a.equal(retryAfter({"Retry-After":"Thu, 01 Jan 2026 00:00:05 GMT"},c.scan.wallNow),5000);
 a.equal(retryAfter({"retry-after":"invalid"},c.scan.wallNow),0);
 let n=0;await read({get:async()=>{if(n++<3)throw limited();return{data:1}}},
 "get","https://mock/get-agent/a",{},c.scan);
 a.deepEqual(c.waits,[250,500,1000]);
});
test("repeated 429 exhausts retries and never returns partial success",async()=>{
 const c=clock();let n=0;
 await a.rejects(read({get:async()=>{n++;throw limited()}},
 "get","https://mock/get-agent/a",{},c.scan),/OWNERSHIP_RATE_LIMIT_EXHAUSTED/);
 a.equal(n,4);a.equal(c.waits.length,3);
});
test("Retry-After beyond remaining deadline fails without sleeping or retrying early",async()=>{
 const c=clock();let n=0;
 await a.rejects(read({get:async()=>{n++;throw limited({"retry-after":"121"})}},
 "get","https://mock/get-agent/a",{},c.scan),/OWNERSHIP_SCAN_DEADLINE/);
 a.equal(n,1);a.deepEqual(c.waits,[]);
});
test("overall deadline includes successful reads and spans pagination",async()=>{
 const c=clock();let n=0;
 await a.rejects(pages({get:async()=>{n++;c.advance(70000);return{data:{items:[n],has_more:true,pagination_key:String(n)}}}},
 "https://mock/list-agent-versions/a",{},"get",c.scan),/OWNERSHIP_SCAN_DEADLINE/);
 a.equal(n,2);
});
test("hung read is aborted at overall deadline",async()=>{
 const scan=createScan();scan.deadline=scan.now()+15;let signal;
 await a.rejects(read({get:async(u,o)=>{signal=o.signal;return new Promise(()=>{})}},
 "get","https://mock/get-agent/a",{},scan),/OWNERSHIP_SCAN_DEADLINE/);
 a.equal(signal.aborted,true);
});
test("retry preserves page cursor and does not append duplicate page items",async()=>{
 const c=clock(),queries=[];let failOnce=true;
 const result=await pages({get:async(u,o)=>{
 queries.push(o.params.pagination_key||null);
 if(!o.params.pagination_key)return{data:{items:[1],has_more:true,pagination_key:"next"}};
 if(failOnce){failOnce=false;throw limited();}
 return{data:{items:[2],has_more:false}};
 }},"https://mock/list-agent-versions/a",{},"get",c.scan);
 a.deepEqual(result,[1,2]);a.deepEqual(queries,[null,"next","next"]);
});
test("cursor repetition remains rejected after a recovered 429",async()=>{
 const c=clock();let n=0;
 await a.rejects(pages({get:async()=>{if(++n===2)throw limited();return{data:{items:[],has_more:true,pagination_key:"same"}}}},
 "https://mock/list-agent-versions/a",{},"get",c.scan),/OWNERSHIP_LIST_INCOMPLETE/);
});
test("non-429 failures and write endpoints are never retried",async()=>{
 for(const url of ["create-agent","update-retell-llm/a","publish-agent-version/a","update-phone-number/a"]){
 const c=clock();let n=0;
 await a.rejects(read({post:async()=>{n++;throw limited()}},"post","https://mock/"+url,{},c.scan),/rate limited/);
 a.equal(n,1);a.deepEqual(c.waits,[]);
 }
 let n=0;await a.rejects(read({get:async()=>{n++;throw Object.assign(Error("unavailable"),{status:503})}},
 "get","https://mock/get-agent/a",{},clock().scan),/unavailable/);a.equal(n,1);
});
test("scan-wide retry budget is shared across requests",async()=>{
 const c=clock();c.scan.retries=20;let n=0;
 await a.rejects(read({get:async()=>{n++;throw limited()}},"get","https://mock/get-agent/a",{},c.scan),
 /OWNERSHIP_RATE_LIMIT_EXHAUSTED/);a.equal(n,1);
});
test("POST list-agents retries read-only listing; exact agent versions still validated",async()=>{
 const c=clock();let lists=0,versions=[];
 const axios={post:async()=>{if(lists++===0)throw limited();return{data:{items:[{agent_id:"a",channel:"voice"}],has_more:false}}},
 get:async(u,o)=>{
 if(u.includes("list-agent-versions"))return{data:{items:[{version:0},{version:1}],has_more:false}};
 versions.push(o.params.version);return{data:{agent_id:"a",version:o.params.version,response_engine:{type:"retell-llm",llm_id:"l"}}};
 }};
 await verifyOwnership(axios,"https://mock",{},"a","l",c.scan);
 a.equal(lists,2);a.deepEqual(versions,[0,1]);
 axios.get=async(u,o)=>u.includes("list-agent-versions")
 ?{data:{items:[{version:0},{version:0}],has_more:false}}
 :{data:{agent_id:"a",version:o.params.version,response_engine:{type:"retell-llm",llm_id:"l"}}};
 await a.rejects(verifyOwnership(axios,"https://mock",{},"a","l",clock().scan),/OWNERSHIP_LIST_INCOMPLETE/);
});
