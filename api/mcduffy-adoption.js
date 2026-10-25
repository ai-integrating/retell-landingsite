const { timingSafeEqual } = require("node:crypto");
const { versionedBusiness } = require("../lib/versioned-business");
const { outboundVersion } = require("../lib/versioned-outbound");
const { REVIEW } = require("../lib/retained-draft");
function createHandler({ kv, axios, secret, apiKey }) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    const a = Buffer.from(req.headers["x-maintenance-secret"] || ""), b = Buffer.from(secret || "");
    if (!b.length || a.length !== b.length || !timingSafeEqual(a,b)) return res.status(401).json({error:"UNAUTHORIZED"});
    try {
      const deps = {kv,axios,base:"https://api.retellai.com",headers:{Authorization:`Bearer ${apiKey}`}};
      if(req.body?.phase==="baseline")return res.json(await require("../lib/mcduffy-baseline").pinBaseline({...deps,body:req.body}));
      const receipt = await versionedBusiness({...deps,body:req.body,expectedLlm:REVIEW.llm_id,
        findUpgradeHits:()=>[],initialAdoption:true});
      if (receipt.state === "active" && await outboundVersion({...deps,agentId:REVIEW.agent_id,
        phoneNumber:REVIEW.phone_number}) !== receipt.agent_version) throw Error("OUTBOUND_UNVERIFIED");
      return res.json(receipt);
    } catch(e) { return res.status([400,403,409,423].includes(e.status)?e.status:503)
      .json({error:/^[A-Z_]+$/.test(e.code||"")?e.code:"ADOPTION_UNAVAILABLE"}); }
  };
}
module.exports=(req,res)=>createHandler({kv:require("@vercel/kv").kv,axios:require("axios"),
  secret:process.env.REFINEMENT_MAINTENANCE_SECRET,apiKey:process.env.RETELL_API_KEY})(req,res);
module.exports.createHandler=createHandler;
