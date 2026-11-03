import assert from 'node:assert/strict'
import {createCandidateApplyGuard} from '../src/lib/ai/candidateApply'
const deferred=()=>{let resolve!:(value:boolean|void)=>void, reject!:(error:Error)=>void
  const promise=new Promise<boolean|void>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
let passed=0
const test=async(name:string,fn:()=>Promise<void>)=>{await fn();passed++;console.log('PASS '+name)}
function fixture(){
  let owner:string|null='project-A:1',accepted=0,rejected=0
  const pending:boolean[]=[]
  const gate=createCandidateApplyGuard({owner:()=>owner,pending:value=>pending.push(value),accepted:()=>accepted++,rejected:()=>rejected++})
  return {gate,pending,owner:(value:string|null)=>{owner=value},counts:()=>({accepted,rejected})}
}
await test('awaits the actual callback before any accepted receipt',async()=>{
  const f=fixture(),d=deferred(),run=f.gate.run(()=>d.promise)
  assert.equal(f.gate.isBusy(),true);assert.equal(f.counts().accepted,0)
  d.resolve();assert.equal(await run,true);assert.deepEqual(f.pending,[true,false]);assert.equal(f.counts().accepted,1)
})
await test('same-event repeated clicks issue only one submission',async()=>{
  const f=fixture(),d=deferred();let writes=0
  const run=f.gate.run(()=>{writes++;return d.promise})
  assert.equal(await f.gate.run(()=>{writes++;return true}),false)
  d.resolve(true);await run;assert.equal(writes,1)
})
await test('an explicit refusal preserves the candidate without accepting',async()=>{
  const f=fixture();assert.equal(await f.gate.run(()=>false),false)
  assert.deepEqual(f.counts(),{accepted:0,rejected:1});assert.equal(f.gate.isBusy(),false)
})
await test('a completed candidate cannot submit twice even before its close commits',async()=>{
  const f=fixture();let writes=0
  assert.equal(await f.gate.run(()=>{writes++;return true}),true)
  assert.equal(await f.gate.run(()=>{writes++;return true}),false)
  assert.equal(writes,1);assert.equal(f.counts().accepted,1)
})
await test('only an explicit new candidate resets completion, never an in-flight callback',async()=>{
  const f=fixture(),d=deferred(),run=f.gate.run(()=>d.promise)
  assert.equal(f.gate.reset(),false)
  d.resolve(true);await run
  assert.equal(f.gate.reset(),true)
  assert.equal(await f.gate.run(()=>true),true)
  assert.equal(f.counts().accepted,2)
})
await test('a thrown or rejected write can only be retried explicitly',async()=>{
  const f=fixture();let calls=0
  assert.equal(await f.gate.run(()=>{calls++;throw Error('failed')}),false)
  assert.equal(calls,1);assert.equal(f.counts().accepted,0)
  assert.equal(await f.gate.run(()=>{calls++;return true}),true)
  assert.equal(calls,2);assert.deepEqual(f.counts(),{accepted:1,rejected:1})
})
await test('late success cannot close a replacement project or mount generation',async()=>{
  for(const next of ['project-B:1','project-A:2',null]){
    const f=fixture(),d=deferred(),run=f.gate.run(()=>d.promise)
    f.owner(next);d.resolve(true);assert.equal(await run,false)
    assert.deepEqual(f.counts(),{accepted:0,rejected:0});assert.deepEqual(f.pending,[true])
  }
})
await test('inactive owners never start callbacks and late errors never affect another owner',async()=>{
  const f=fixture();f.owner(null);let calls=0
  assert.equal(await f.gate.run(()=>{calls++;return true}),false);assert.equal(calls,0)
  f.owner('project-A:1');const d=deferred(),run=f.gate.run(()=>d.promise)
  f.owner('project-B:1');d.reject(Error('old failure'));await run
  assert.deepEqual(f.counts(),{accepted:0,rejected:0})
})
console.log(`${passed} groups passed`)
