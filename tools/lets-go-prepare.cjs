// Offline preparation only: no live transport or environment credentials.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {validate, replaceSection, range} = require("../lib/refinement-section");
const TARGET = Object.freeze({
  client:"lets-go-6659962517436476386", agent:"agent_67e9dc0ab56576c4b9d3264eaa",
  llm:"llm_4b9754f0d31810c67f2d4354c105"
});
function plan(recovery, input) {
  const {agent,llm}=recovery, request=validate(input);
  assert.equal(request.client_id,TARGET.client); assert.equal(request.agent_id,TARGET.agent);
  assert.equal(agent.agent_id,TARGET.agent); assert.equal(agent.response_engine.llm_id,TARGET.llm);
  assert.equal(llm.llm_id,TARGET.llm); assert.equal(agent.response_engine.version,llm.version);
  assert.equal(agent.is_published,false); assert.equal(llm.is_published,false);
  const before=llm.general_prompt, after=replaceSection(before,request), old=range(before), next=range(after);
  if(old) {
    assert.equal(before.slice(0,old.start),after.slice(0,next.start));
    assert.equal(before.slice(old.end),after.slice(next.end));
  } else {
    assert.equal(before,after.slice(0,before.length));
    assert.equal(after.slice(before.length,next.start),before?"\n\n":"");
  }
  const candidate=structuredClone(llm); candidate.general_prompt=after;
  const a={...llm},b={...candidate}; delete a.general_prompt; delete b.general_prompt;
  assert.deepEqual(a,b);
  return {before,after,request,checks:{outsideSectionPreserved:true,toolsAndConfigurationPreserved:true,managedSectionExists:!!old}};
}
if(require.main===module) {
  try {
    process.umask(0o077);
    const [recoveryPath,requestPath,out]=process.argv.slice(2);
    assert.ok(out); fs.mkdirSync(out,{mode:0o700}); // refuses existing output
    const result=plan(JSON.parse(fs.readFileSync(recoveryPath)),JSON.parse(fs.readFileSync(requestPath)));
    for(const name of ["before","after"]) fs.writeFileSync(path.join(out,name+".txt"),result[name],{mode:0o600});
    const diff=spawnSync("diff",["-u","before.txt","after.txt"],{cwd:out,encoding:"utf8"});
    assert.ok([0,1].includes(diff.status));
    fs.writeFileSync(path.join(out,"proposal.diff"),diff.stdout,{mode:0o600});
    fs.writeFileSync(path.join(out,"checks.json"),JSON.stringify(result.checks),{mode:0o600});
    console.log("Offline proposal prepared; no live services contacted.");
  } catch { console.error("Preparation failed; private details suppressed.");process.exitCode=1; }
}
module.exports={TARGET,plan};
