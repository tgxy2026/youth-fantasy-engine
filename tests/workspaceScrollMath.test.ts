import assert from 'node:assert/strict'
import { firstVisibleAnchor, anchorScrollTop, ratioScrollTop, createScrollTargetRequests, viewportScale } from '../src/lib/settings/workspaceScrollMath'
import { createWorkspaceViewStore, type WorkspaceScope } from '../src/lib/settings/workspaceViewState'
let count=0
const check=(name:string,run:()=>void)=>{run();count++;console.log('PASS '+name)}
check('the first partly visible row keeps its signed offset and skips missing or invalid rows',()=>{
  assert.deepEqual(firstVisibleAnchor([{id:'old',top:0,bottom:90},{id:'part',top:87,bottom:160},{id:'next',top:160,bottom:220}],100,200),{id:'part',offset:-13})
  assert.equal(firstVisibleAnchor([{id:'bad\nrow',top:100,bottom:140}],100,200),undefined)
})
check('semantic anchors compensate for insertion and reflow before the visible object',()=>{
  assert.equal(anchorScrollTop(1000,370,100,-13,4000),1283)
  assert.equal(anchorScrollTop(1000,-230,100,-13,4000),683)
})
check('CSS zoom rects convert to the scrollTop coordinate system',()=>{
  const scale=viewportScale(500,400)
  assert.equal(scale,1.25)
  assert.equal(anchorScrollTop(1000,462.5/scale,125/scale,-13,4000),1283)
  assert.equal(viewportScale(0,0),1)
})
check('removed anchors fall back to the start and finite results remain inside scroll bounds',()=>{
  assert.equal(anchorScrollTop(2000,null,100,-13,4000),0)
  assert.equal(anchorScrollTop(1000,9000,100,0,2000),2000)
  assert.equal(anchorScrollTop(10,-800,100,0,2000),0)
  assert.equal(anchorScrollTop(10,NaN,100,0,2000),0)
  assert.equal(ratioScrollTop(.4,2500),1000);assert.equal(ratioScrollTop(2,2500),2500);assert.equal(ratioScrollTop(Infinity,2),0)
})
check('clearing an acknowledged prop keeps pending request ownership; fresh same-id generations work again',()=>{
  const update=createScrollTargetRequests(),first=update('owner',1,'row-b')
  assert.equal(update('owner',1,null),first);first.consumed=true
  assert.equal(update('owner',1,null).consumed,true)
  const second=update('owner',2,'row-b');assert.notEqual(second,first);assert.equal(second.consumed,false)
  assert.equal(update('owner',3,null).id,null)
})
check('legacy focus cycles and owner changes never reuse a consumed activation',()=>{
  const update=createScrollTargetRequests(),first=update('a',undefined,'b')
  first.consumed=true;update('a',undefined,null)
  assert.notEqual(update('a',undefined,'b'),first)
  assert.equal(update('b',undefined,null).consumed,true)
})
check('bounded anchors are copied as metadata only, and malformed offsets are rejected',()=>{
  const store=createWorkspaceViewStore(),scope:WorkspaceScope={platform:'browser',space:'opaque',identity:'local',projectId:'project',pageId:'list:outline'}
  const value={version:1,kind:'list',objectId:'list-state',selectedId:'row',query:'',scroll:{top:100,ratio:.2,outerTop:0,outerRatio:0},anchor:{id:'row',offset:-13,body:'not retained'}}
  assert.equal(store.put(scope,value),true)
  const saved=store.get(scope,'list-state')
  assert.deepEqual(saved?.kind==='list'?saved.anchor:undefined,{id:'row',offset:-13})
  for(const offset of [NaN,Infinity,-Infinity,1e10])assert.equal(store.put(scope,{...value,anchor:{id:'row',offset}}),false)
})
console.log('workspaceScrollMath '+count+' passed')
