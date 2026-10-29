import assert from 'node:assert/strict'
import {storageWriteStatus, type StorageWriteFacts} from '../src/lib/app/storageWriteStatus'
const base: StorageWriteFacts={connected:true,dirty:false,saving:false,lastError:'',lastSavedAt:100}
let passed=0
const test=(name:string,fn:()=>void)=>{fn();passed++;console.log('PASS '+name)}
test('only an actual valid receipt with no outstanding facts permits success',()=>{
  assert.equal(storageWriteStatus(base).kind,'saved')
  for(const lastSavedAt of [0,-1,NaN,Infinity])assert.equal(storageWriteStatus({...base,lastSavedAt}).kind,'idle')
})
test('a previous receipt cannot hide a newer pending or in-flight write',()=>{
  assert.equal(storageWriteStatus({...base,dirty:true}).kind,'pending')
  const current=storageWriteStatus({...base,dirty:true,saving:true})
  assert.equal(current.kind,'writing');assert.equal(current.canSave,false)
})
test('failures survive stale success and in-flight retry until backend clears them',()=>{
  const facts={...base,saving:true,lastError:'private failure detail'}
  assert.equal(storageWriteStatus(facts).kind,'error')
  assert.equal(storageWriteStatus(facts).canSave,false)
  assert.equal(storageWriteStatus({...facts,saving:false}).canSave,true)
  assert.equal(storageWriteStatus(facts).description.includes('private failure detail'),false)
})
test('conflicts and locks outrank all optimistic or error states and cannot retry or unlock',()=>{
  for(const flags of [{writeLocked:true},{saveConflict:true},{writeLocked:true,saveConflict:true}]){
    const result=storageWriteStatus({...base,dirty:true,saving:true,lastError:'old',...flags})
    assert.equal(result.kind,flags.saveConflict?'conflict':'locked');assert.equal(result.canSave,false)
  }
})
test('uninitialized storage cannot claim an old receipt or accept save',()=>{
  const result=storageWriteStatus({...base,connected:false,dirty:true})
  assert.equal(result.kind,'connecting');assert.equal(result.canSave,false)
})
test('presentation neither mutates source facts nor incorporates paths or provider credentials',()=>{
  const facts=Object.freeze({...base,lastError:'https://private.example/?token=SECRET',dataPath:'C:/private/file.json'})
  const result=storageWriteStatus(facts)
  assert.equal(JSON.stringify(result).includes('SECRET'),false)
  assert.equal(JSON.stringify(result).includes('private'),false)
  assert.equal(facts.lastError,'https://private.example/?token=SECRET')
})
console.log(`${passed} groups passed`)
