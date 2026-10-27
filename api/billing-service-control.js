const crypto = require("node:crypto");
const { kv } = require("@vercel/kv");
const axios = require("axios");
const {ENABLED,operation} = require("../lib/billing-cancellation");
module.exports = async (req,res) => {
  const supplied = String(req.headers.authorization || "").replace(/^Bearer /,"");
  const expected = process.env.BILLING_SERVICE_SECRET || "";
  if (!expected || !supplied || Buffer.byteLength(supplied)!==Buffer.byteLength(expected) ||
    !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))
    return res.status(401).json({error:"UNAUTHORIZED"});
  if (!ENABLED) return res.status(503).json({error:"BILLING_DISABLED"});
  if (req.method!=="POST") return res.status(405).json({error:"METHOD_NOT_ALLOWED"});
  const body = req.body;
  if (!body || typeof body.key!=="string" || body.key.length>250 ||
    !["resolve","inspect","suspend"].includes(body.action))
    return res.status(400).json({error:"INVALID_REQUEST"});
  const token = crypto.randomUUID(), lock = `billing:test:lease:${body.clientId}`;
  if (!await kv.set(lock,token,{nx:true,ex:60})) return res.status(409).json({error:"BUSY"});
  const started=Date.now();
  const fence=async()=>{
    if(Date.now()-started>30000||await kv.get(lock)!==token)throw Error("LEASE_EXPIRED");
  };
  const headers={Authorization:`Bearer ${process.env.RETELL_API_KEY}`};
  const io={
    now:()=>Math.floor(Date.now()/1000),
    get:k=>kv.get(k),
    set:async(k,v)=>{await fence();await kv.set(k,v);},
    phone:async number=>{await fence();return (await axios.get(
      `https://api.retellai.com/get-phone-number/${encodeURIComponent(number)}`,{headers,timeout:10000})).data;},
    patchPhone:async(number,data)=>{await fence();await axios.patch(
      `https://api.retellai.com/update-phone-number/${encodeURIComponent(number)}`,data,{headers,timeout:10000});},
  };
  try{return res.json(await operation(io,body));}
  catch{return res.status(409).json({error:"SERVICE_REVIEW_OR_RECOVERY_REQUIRED"});}
  finally{await kv.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",[lock],[token]);}
};
