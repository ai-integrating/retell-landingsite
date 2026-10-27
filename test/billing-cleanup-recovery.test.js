const {test}=require("node:test"),assert=require("node:assert/strict");
const {recover}=require("../tools/billing-cleanup-recovery.cjs"),{hash}=require("../lib/billing-cancellation");
test("separate cleanup grant works after execution expires; lost delete reply recovers without repeat",async()=>{
 const manifest={runId:"test",expiresAt:1,cleanupResources:[{kind:"number",id:"synthetic",createdByTest:true}]};
 let exists=true,writes=0;const events=[];
 const args={manifest,grant:{purpose:"cleanup-only",runId:"test",manifestHash:hash(manifest),expiresAt:200},
 token:"c".repeat(32),secret:"c".repeat(32),executionSecret:"e".repeat(32),
 io:{now:()=>100,assertIdle:async()=>{},inventoryHash:async()=>hash(manifest.cleanupResources),retainEvidence:async()=>events.push("evidence"),
 exists:async()=>exists,remove:async()=>{writes++;exists=false;throw Error("lost");},recordRemoval:async()=>events.push("removed")}};
 await assert.rejects(recover(args),/lost/);assert.equal(writes,1);
 assert.equal((await recover(args)).state,"cleanup-verified");assert.equal(writes,1);
 await assert.rejects(recover({...args,token:args.executionSecret}),/UNAUTHORIZED/);
 await assert.rejects(recover({...args,manifest:{...manifest,cleanupResources:[{kind:"number",id:"customer",createdByTest:true}]}}),/GRANT_INVALID/);
 await assert.rejects(recover({...args,grant:{...args.grant,expiresAt:99}}),/GRANT_INVALID/);
 await assert.rejects(recover({...args,io:{...args.io,assertIdle:async()=>{throw Error("TEST_LEASE_ACTIVE");}}}),/LEASE_ACTIVE/);
});
