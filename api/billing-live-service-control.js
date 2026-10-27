const crypto=require("node:crypto");
const {kv}=require("@vercel/kv");
const axios=require("axios");
const {operation}=require("../lib/billing-cancellation");
const {LIVE_ENABLED,approved}=require("../lib/billing-live-policy");
module.exports=async(req,res)=>{
 const expected=process.env.BILLING_LIVE_SERVICE_SECRET||"";
 const supplied=String(req.headers.authorization||"").replace(/^Bearer /,"");
 if(!expected||!supplied||Buffer.byteLength(expected)!==Buffer.byteLength(supplied)||
 !crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)))
 return res.status(401).json({error:"UNAUTHORIZED"});
 if(!LIVE_ENABLED||process.env.BILLING_CANCELLATION_PAUSED==="true")
 return res.status(503).json({error:"BILLING_DISABLED"});
 if(req.method!=="POST")return res.status(405).json({error:"METHOD_NOT_ALLOWED"});
 const b=req.body;
 if(!b||typeof b.key!=="string"||b.key.length>250||!Number.isSafeInteger(b.clientId)||
 typeof b.bindingId!=="string"||!["resolve","inspect","suspend"].includes(b.action))
 return res.status(400).json({error:"INVALID_REQUEST"});
 // Fail before even acquiring a lease for unapproved resources.
 const r=await kv.get(`billing:live:resource:${b.key}`);
 if(!approved(r)||r.clientId!==b.clientId||!r.bindingIds.includes(b.bindingId)||
 r.ownershipHash!==b.ownershipHash)return res.status(403).json({error:"RESOURCE_NOT_APPROVED"});
 const lock=`billing:live:lease:${b.clientId}`,token=crypto.randomUUID(),started=Date.now();
 if(!await kv.set(lock,token,{nx:true,ex:60}))return res.status(409).json({error:"BUSY"});
 const fence=async()=>{
  if(process.env.BILLING_CANCELLATION_PAUSED==="true"||Date.now()-started>30000||
    await kv.get(lock)!==token)throw Error("LEASE_EXPIRED");
 };
 const options={headers:{Authorization:`Bearer ${process.env.RETELL_API_KEY}`},timeout:10000};
 try{
 const io={now:()=>Math.floor(Date.now()/1000),
 get:async k=>{await fence();return kv.get(k);},
 set:async(k,v)=>{await fence();return kv.set(k,v);},
 phone:async n=>{await fence();return (await axios.get(`https://api.retellai.com/get-phone-number/${encodeURIComponent(n)}`,options)).data;},
 patchPhone:async(n,p)=>{await fence();await axios.patch(`https://api.retellai.com/update-phone-number/${encodeURIComponent(n)}`,p,options);}};
 return res.json(await operation(io,b,{namespace:"live",approved}));
 }catch{return res.status(409).json({error:"SERVICE_REVIEW_OR_RECOVERY_REQUIRED"});}
 finally{await kv.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",[lock],[token]);}
};
