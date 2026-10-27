const {timingSafeEqual}=require("node:crypto");
const {hash}=require("../lib/billing-cancellation");
// This entry point has NO suspend/call/purchase/publication capability.
async function recover({manifest,grant,token,secret,executionSecret,io}){
 const a=Buffer.from(token||""),b=Buffer.from(secret||"");
 if(secret===executionSecret||b.length<32||a.length!==b.length||!timingSafeEqual(a,b))throw Error("CLEANUP_UNAUTHORIZED");
 if(grant.purpose!=="cleanup-only"||grant.manifestHash!==hash(manifest)||
 grant.runId!==manifest.runId||!Number.isFinite(grant.expiresAt)||grant.expiresAt<=io.now())
 throw Error("CLEANUP_GRANT_INVALID");
 const resources=manifest.cleanupResources;
 if(!Array.isArray(resources)||!resources.length||resources.some(r=>!r.createdByTest||
 !["number","agent","llm"].includes(r.kind)||!r.id)||
 new Set(resources.map(r=>r.kind+":"+r.id)).size!==resources.length)throw Error("CLEANUP_SCOPE");
 // Inventory was fixed when resources were created, independent of later grants.
 if(await io.inventoryHash(manifest.runId)!==hash(resources))throw Error("CREATION_INVENTORY_CHANGED");
 await io.assertIdle();
 await io.retainEvidence();
 const order={number:0,agent:1,llm:2};
 for(const r of [...resources].sort((a,b)=>order[a.kind]-order[b.kind])){
 if(grant.expiresAt<=io.now())throw Error("CLEANUP_GRANT_EXPIRED");
 await io.assertIdle();
 if(await io.exists(r))await io.remove(r); // uncertainty stops; next invocation reads first
 if(await io.exists(r))throw Error("REMOVAL_UNCONFIRMED");
 await io.recordRemoval(r);
 }
 return {state:"cleanup-verified",manifestHash:hash(manifest)};
}
module.exports={recover};
