const { timingSafeEqual } = require("node:crypto");
const { initialize } = require("../lib/onboarding-business");
function createHandler(deps) {
  return require("../lib/ownership-budget").handler(async (req,res) => {
    res.setHeader("Cache-Control","no-store");
    if(req.method!=="POST")return res.status(405).json({error:"METHOD_NOT_ALLOWED"});
    const a=Buffer.from(typeof req.headers["x-maintenance-secret"]==="string"?req.headers["x-maintenance-secret"]:"");
    const b=Buffer.from(deps.secret||"");
    if(!b.length||a.length!==b.length||!timingSafeEqual(a,b))return res.status(401).json({error:"UNAUTHORIZED"});
    try{return res.json(await initialize({...deps,body:req.body}));}
    catch(e){return res.status([400,403,409,423].includes(e.status)?e.status:503)
      .json({error:/^[A-Z_]+$/.test(e.code||"")?e.code:"INITIALIZATION_UNCONFIRMED"});}
  });
}
module.exports=(req,res)=>createHandler({kv:require("@vercel/kv").kv,axios:require("axios"),
  base:"https://api.retellai.com",headers:{Authorization:`Bearer ${process.env.RETELL_API_KEY}`},
  secret:process.env.REFINEMENT_MAINTENANCE_SECRET})(req,res);
module.exports.createHandler=createHandler;
