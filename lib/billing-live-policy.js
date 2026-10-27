const crypto=require("node:crypto");
const LIVE_ENABLED=false;
// Reviewed exact registry hashes. No real customer is approved in this release.
const APPROVED_RESOURCES=[];
const digest=v=>crypto.createHash("sha256").update(JSON.stringify(v,function(k,x){
 return x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x;
})).digest("hex");
function approved(r){
 return !!r&&r.testOnly===false&&r.numberPolicy==="retain_disconnected"&&
 APPROVED_RESOURCES.some(a=>a.key===r.key&&a.clientId===r.clientId&&a.registryHash===digest(r));
}
module.exports={LIVE_ENABLED,APPROVED_RESOURCES,approved,digest};
