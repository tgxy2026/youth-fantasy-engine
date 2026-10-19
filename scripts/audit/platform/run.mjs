import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath}from 'node:url'
import {spawn}from 'node:child_process'
import {snapshot,parse}from './source.mjs'
import {modelProfiles}from './source.mjs'
import {scanPlatform}from './scan.mjs'

const args=process.argv.slice(2)
if(args.includes('--help')){
  console.log('node scripts/audit/platform/run.mjs [workspace] [--matrix] [--base git-ref] [--evidence ledger.json]\nRead-only source audit; no network, deployment or application data writes. Exit 0=defined evidence complete, 1=confirmed violation, 2=incomplete/blocked.')
  process.exit(0)
}
let root=path.resolve(fileURLToPath(new URL('../../..',import.meta.url))),evidencePath,base,matrixRequested=false
for(let i=0;i<args.length;i++){
  const a=args[i]
  if(a==='--matrix')matrixRequested=true
  else if(a==='--evidence'||a==='--base'){
    const v=args[++i];if(!v||v.startsWith('--'))throw new Error(`${a} requires a value`)
    if(a==='--evidence')evidencePath=path.resolve(v);else base=v
  }else if(!a.startsWith('-')&&i===0)root=path.resolve(a)
  else throw new Error(`Unknown platform audit argument: ${a}`)
}
const policy=JSON.parse(fs.readFileSync(new URL('./policy.json',import.meta.url),'utf8'))
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),out=path.join(root,'.workbuddy/tmp/platform-audit',stamp)
fs.mkdirSync(out,{recursive:true})
const initial=snapshot(root)
const report={schemaVersion:1,scope:'source-governance; static/model results are not packaged or deployed acceptance',version:JSON.parse(initial.sources.get('package.json')??'{}').version,sourceFingerprint:initial.fingerprint,generatedAt:new Date().toISOString(),policy,diagnostics:[...initial.diagnostics],findings:[],inventory:{},runtime:[]}
for(const[file,text]of initial.sources)if(/\.(tsx?|[cm]?js)$/.test(file)&&!file.startsWith('scripts/audit/')){
  const u=parse(file,text)
  for(const d of u.parseDiagnostics)report.diagnostics.push({status:'blocked',file,line:u.getLineAndCharacterOfPosition(d.start??0).line+1,reason:'语法解析受阻；此文件不能算已完成检查'})
}
report.model=modelProfiles(initial.sources,policy)
Object.assign(report,scanPlatform(initial.sources,policy,report.model))
if(base){
  if(base.startsWith('-')||!/^[-\w./~^]+$/.test(base))throw new Error('Invalid git reference')
  const changed=await new Promise(resolve=>{
    const p=spawn('git',['-c','core.quotePath=false','diff','--name-only','--no-ext-diff',base,'--','src','electron','server','scripts','portable','public','package.json','index.html','vite.config.ts'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let text='',done=false
    p.stdout.on('data',d=>text+=d);p.stderr.resume()
    const timer=setTimeout(()=>p.kill(),15_000)
    const finish=value=>{if(!done){done=true;clearTimeout(timer);resolve(value)}}
    p.on('error',()=>finish(null));p.on('close',code=>finish(code===0?text.trim().split(/\r?\n/).filter(Boolean):null))
  })
  if(!changed)report.diagnostics.push({status:'blocked',reason:'无法读取git改动清单；未缩小扫描范围'})
  report.changedFiles=changed
  // Diff affects prioritisation only. Whole-source audit always runs, and untracked source is fingerprinted.
  report.changeImpact=changed?.map(file=>({file,domain:file.startsWith('server/')?'identity/delivery':/storage|\/db\/|sync/.test(file)?'persistence':/ai|transport|[Nn]et/.test(file)?'network':file.startsWith('scripts/')||file.startsWith('electron/')?'delivery':'platform',profiles:['desktop','portable','web-cloud','web-guest']}))
}
let ledger=null
if(evidencePath)try{
  ledger=JSON.parse(fs.readFileSync(evidencePath,'utf8'))
  if(ledger.sourceFingerprint!==initial.fingerprint)throw new Error('源码/服务端/构建脚本或治理配置指纹已变化，旧证据不能沿用')
  if(!Array.isArray(ledger.decisions)||!Array.isArray(ledger.runtime))throw new Error('decisions/runtime must be arrays')
  const ids=ledger.decisions.map(d=>d.id),cells=ledger.runtime.map(c=>c.id+':'+c.profile)
  if(new Set(ids).size!==ids.length||new Set(cells).size!==cells.length)throw new Error('duplicate decision or runtime evidence')
  for(const d of ledger.decisions)if(!report.findings.some(f=>f.id===d.id))throw new Error('unknown finding id')
  for(const c of ledger.runtime)if(!policy.runtimeCases.some(r=>r.id===c.id&&r.profiles.includes(c.profile)))throw new Error('unknown runtime case/profile')
}catch(e){ledger=null;report.diagnostics.push({status:'blocked',reason:'治理记录不可用：'+e.message})}
for(const f of report.findings){
  const d=ledger?.decisions.find(d=>d.id===f.id)
  const valid=d&&['confirmed','false-positive','accepted-difference','deferred'].includes(d.status)&&typeof d.reason==='string'&&d.reason.trim().length>=10&&typeof d.owner==='string'&&d.owner.trim()&&Number.isFinite(Date.parse(d.expiresAt))&&Date.parse(d.expiresAt)>Date.now()
  if(valid){f.status=d.status;f.decision={owner:d.owner,reason:d.reason,expiresAt:d.expiresAt}}
  else if(d)f.reviewError='缺少负责人、具体理由或有效到期时间；不自动忽略'
}
for(const spec of policy.runtimeCases)for(const profile of spec.profiles){
  const row={id:spec.id,profile,status:'unverified',description:spec.description,requiredScenarios:spec.scenarios}
  const e=ledger?.runtime.find(e=>e.id===spec.id&&e.profile===profile)
  if(e?.status==='failed')row.status='failed'
  else if(e?.status==='blocked'||e?.status==='deferred'){row.status=e.status;row.reason=e.reason??'未完成，不能报通过'}
  else if(e?.status==='passed'){
    try{
      if(!Number.isInteger(e.samples)||e.samples<1||!Array.isArray(e.scenarios)||!spec.scenarios.every(s=>e.scenarios.includes(s)))throw new Error('缺少正样本或必要场景')
      if(typeof e.environment!=='string'||!e.environment.trim()||!e.artifact?.path||!e.artifact.sha256)throw new Error('缺少实测环境或产物哈希')
      const artifact=path.resolve(root,e.artifact.path)
      if(!fs.statSync(artifact).isFile())throw new Error('证据产物不是文件')
      if(crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')!==e.artifact.sha256)throw new Error('证据产物内容已变化')
      row.status='passed';row.environment=e.environment;row.artifact=e.artifact
    }catch(err){row.reason=err.message}
  }
  report.runtime.push(row)
}
const finalSnapshot=snapshot(root)
report.diagnostics.push(...finalSnapshot.diagnostics)
if(finalSnapshot.fingerprint!==initial.fingerprint)report.diagnostics.push({status:'blocked',reason:'审计期间源码变化，本轮快照过期，请重新执行'})
const failed=report.model.some(m=>m.status==='failed')||report.findings.some(f=>f.status==='confirmed')||report.runtime.some(r=>r.status==='failed')
report.status=failed?'failed':report.model.every(m=>m.status==='model-matched')&&report.findings.every(f=>['false-positive','accepted-difference'].includes(f.status))&&report.runtime.every(r=>r.status==='passed')&&!report.diagnostics.length?'complete':'incomplete'
fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2))
const lines=['# 三端兼容专项审计','',`版本：${report.version}；状态：**${report.status}**。源码模型匹配不等于真实启动/部署通过。`,'',`指纹：\`${report.sourceFingerprint}\``,'','## 源码模型推演','', '| 运行配置 | DESKTOP | PORTABLE | WEB | GUEST | 后端 | 结果 |','|---|---|---|---|---|---|---|',...report.model.map(m=>`| ${m.label} | ${m.observed.DESKTOP} | ${m.observed.PORTABLE} | ${m.observed.WEB} | ${m.observed.WEB_GUEST} | ${m.observedStore??'unknown'} | ${m.status} |`),'','## 候选冲突（需逐条复核）','',...report.findings.map(f=>`- **${f.severity}/${f.status}** ${f.id} [${f.rule}] ${f.file}:${f.line}：${f.message}；涉及 ${f.affected.join('/')}；归属 ${f.owner}`),'','## 运行证据矩阵','',...report.runtime.map(r=>`- **${r.status}** ${r.id}/${r.profile}：${r.description}${r.reason?'；'+r.reason:''}`),'','## 治理与边界','', '- 差异允许保留，但必须登记负责人、理由、影响配置、期限与同一源码指纹；deferred不是通过。','- 本次不连接生产服务、不读取实际用户数据、不启动应用、不执行构建或部署。','- 源码扫描不证明账号隔离、持久化、CORS或真实回滚可靠；运行证据缺失必须保留。','',...report.diagnostics.map(d=>`- blocked：${d.file??''} ${d.reason}`)]
const detail=['## 源码结构观察（不代替运行验证）','', '| 外置存储 | 当前白名单 | 登记结果 |','|---|---|---|',...report.inventory.sidecars.map(s=>`| ${s.file} | ${s.actual?.join(', ')??'无法静态读取'} | ${s.status} |`),'', ...report.inventory.injection.map(i=>`- 注入源 ${i.file}：${i.flags.join(', ')}；${i.note}`),...report.inventory.delivery.map(d=>`- 交付入口 ${d.file}：${d.present?'源码存在':'缺失'}，运行状态 ${d.status}`),'']
lines.splice(lines.indexOf('## 治理与边界'),0,...detail)
fs.writeFileSync(path.join(out,'report.md'),lines.join('\n'))
if(matrixRequested)console.log(lines.slice(lines.indexOf('| 运行配置 | DESKTOP | PORTABLE | WEB | GUEST | 后端 | 结果 |'),lines.indexOf('## 候选冲突（需逐条复核）')).join('\n'))
console.log(`Platform audit ${report.status}: ${report.findings.length} candidates, ${report.runtime.filter(r=>r.status==='passed').length}/${report.runtime.length} runtime cells verified.\nReport: ${path.join(out,'report.md')}`)
process.exitCode=report.status==='failed'?1:report.status==='complete'?0:2
