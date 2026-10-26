// Explicitly injected transport: this module never loads customer credentials.
const {timingSafeEqual} = require("node:crypto");
const {operation,hash} = require("../lib/billing-cancellation");
function authorize(manifest, supplied, expected, now) {
  const a=Buffer.from(supplied||""),b=Buffer.from(expected||"");
  if(b.length<32||a.length!==b.length||!timingSafeEqual(a,b))throw Error("UNAUTHORIZED");
  if(manifest.mode!=="isolated-test"||manifest.customerResources!==false||
    !manifest.runId||!Number.isFinite(manifest.expiresAt)||manifest.expiresAt<=now||
    !Array.isArray(manifest.resources)||!manifest.resources.length)throw Error("INVALID_TEST_MANIFEST");
  if(new Set(manifest.resources.map(r=>r.key)).size!==manifest.resources.length)throw Error("DUPLICATE_RESOURCE");
}
function createRunner({manifest,token,secret,io}) {
  authorize(manifest,token,secret,io.now());
  const check=body=>{
    authorize(manifest,token,secret,io.now());
    const r=manifest.resources.find(r=>r.key===body.key);
    if(!r||!r.createdByTest||r.clientId!==body.clientId||
      !r.bindingIds.includes(body.bindingId)||r.ownershipHash!==body.ownershipHash||
      body.intent?.id!==manifest.runId)throw Error("TEST_SCOPE_MISMATCH");
    return r;
  };
  return {
    async suspend(body) {
      const r=check(body);
      // Coverage must come from the fresh TEST Stripe adapter, not the request.
      if(await io.hasOtherPaidCoverage(r.key,body.bindingId))return {state:"shared-preserved"};
      const scopedIO={...io,
        set:async(key,value)=>{
          check(body);
          await io.assertLease();
          if(await io.hasOtherPaidCoverage(r.key,body.bindingId))throw Error("COVERAGE_CHANGED");
          return io.set(key,value);
        },
        get:async key=>{
          const value=await io.get(key);
          if(key===`billing:test:resource:${r.key}`&&hash(value)!==hash(r))
            throw Error("TEST_REGISTRY_CHANGED");
          return value;
        },
        phone:async number=>{
          check(body);
          await io.assertLease();
          if(number!==r.target)throw Error("TEST_PHONE_SCOPE");
          return io.phone(number);
        },
        patchPhone:async(number,patch)=>{
          check(body);
          await io.assertLease();
          if(number!==r.target||!manifest.numbers?.some(n=>n.id===number&&n.createdByTest))
            throw Error("TEST_PHONE_SCOPE");
          if(await io.hasOtherPaidCoverage(r.key,body.bindingId))throw Error("COVERAGE_CHANGED");
          return io.patchPhone(number,patch);
        }};
      return operation(scopedIO,{...body,action:"suspend"});
    },
    async cleanup() {
      authorize(manifest,token,secret,io.now());
      for(const number of manifest.numbers||[]) {
        if(!number.createdByTest||!manifest.resources.some(r=>r.target===number.id))
          throw Error("CLEANUP_SCOPE_MISMATCH");
      }
      await io.retainEvidence();
      for(const number of manifest.numbers||[]) {
        authorize(manifest,token,secret,io.now());
        // Read-back before every delete; never blindly retry an uncertain write.
        if(await io.numberExists(number.id))await io.releaseNumber(number.id);
        if(await io.numberExists(number.id))throw Error("NUMBER_REMOVAL_UNCONFIRMED");
      }
      await io.deleteTestResources();
      await io.verifyCleanup();
    }
  };
}
module.exports={createRunner,authorize};
