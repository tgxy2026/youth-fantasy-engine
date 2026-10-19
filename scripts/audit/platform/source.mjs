import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import ts from 'typescript'
import vm from 'node:vm'

const extensions = /\.(?:ts|tsx|mjs|cjs|js|json|html|css|sh|bat|service|ya?ml)$/
const assets = /\.(?:svg|png|webp|ico|woff2?)$/
const skip = new Set(['node_modules','.git','dist','release'])
export function snapshot(root) {
  const paths = [],diagnostics=[]
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    let entries
    try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{diagnostics.push({status:'blocked',file:path.relative(root,dir),reason:'无法枚举源码目录'});return}
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue
      const file=path.join(dir,e.name)
      const relative=path.relative(root,file).replaceAll('\\','/')
      if(/^(?:server|portable)\/(?:data|backups|logs)(?:\/|$)/.test(relative))continue
      if(relative.startsWith('server/')&&e.name.endsWith('.json')&&e.name!=='package.json')continue
      if (e.isDirectory()) walk(file)
      else if(extensions.test(e.name)||assets.test(e.name)) paths.push(file)
    }
  }
  for(const dir of ['src','electron','server','scripts','portable','public']) walk(path.join(root,dir))
  for(const name of ['package.json','index.html','vite.config.ts','electron-builder.yml','electron-builder.yaml']) if(fs.existsSync(path.join(root,name))) paths.push(path.join(root,name))
  const sources=new Map(),hash=crypto.createHash('sha256')
  for(const file of paths.sort()) {
    const relative=path.relative(root,file).replaceAll('\\','/')
    let bytes
    try{bytes=fs.readFileSync(file)}catch{diagnostics.push({status:'blocked',file:relative,reason:'源码读取失败或执行中被移动'});hash.update(relative+'\0UNREADABLE\0');continue}
    hash.update(relative);hash.update('\0');hash.update(bytes);hash.update('\0')
    if(extensions.test(file))sources.set(relative,bytes.toString('utf8'))
  }
  return {fingerprint:hash.digest('hex'),sources,diagnostics}
}
export const visit=(node,fn)=>{fn(node);ts.forEachChild(node,n=>visit(n,fn))}
export const parse=(file,text)=>ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true)
export function initializer(unit,name) {
  let result
  visit(unit,n=>{if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text===name&&n.initializer)result=n.initializer})
  return result
}
export function safeExpression(node,unit,context) {
  if(!node)throw new Error('source initializer missing')
  let callable=false
  visit(node,n=>{if(ts.isCallExpression(n)||ts.isNewExpression(n)||ts.isFunctionLike(n)||ts.isAwaitExpression(n))callable=true})
  if(callable)throw new Error('initializer now contains a call; manual model update required')
  const code=ts.transpileModule(`(${node.getText(unit)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  return vm.runInNewContext(code,context,{timeout:100,contextCodeGeneration:{strings:false,wasm:false}})
}
export function modelProfiles(sources,policy) {
  const asts=new Map(Object.entries(policy.flagSources).map(([,file])=>[file,parse(file,sources.get(file)??'')]))
  const platform=asts.get(policy.flagSources.WEB),flags=initializer(platform,'flags')
  const core=parse('src/lib/db/core.ts',sources.get('src/lib/db/core.ts')??''),ops=initializer(core,'ops')
  return policy.profiles.map(profile=>{
    const row={id:profile.id,label:profile.label,expected:profile.expected,expectedStore:profile.store,status:'observed',observed:{}}
    try{
      const context={window:structuredClone(profile.window),desktopStore:'desktopStore',portableStore:'portableStore',idbOps:'idbOps'}
      context.flags=safeExpression(flags,platform,context)
      for(const [name,file]of Object.entries(policy.flagSources))row.observed[name]=context[name]=safeExpression(initializer(asts.get(file),name),asts.get(file),context)
      row.observedStore=safeExpression(ops,core,context)
      row.status=Object.entries(profile.expected).every(([k,v])=>row.observed[k]===v)&&row.observedStore===profile.store?'model-matched':'failed'
    }catch(e){row.status='blocked';row.reason=e.message}
    return row
  })
}
