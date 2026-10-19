import ts from 'typescript'
import crypto from 'node:crypto'
import {builtinModules}from 'node:module'
import {parse,visit,initializer,safeExpression}from './source.mjs'

export function scanPlatform(sources,policy,profiles) {
  const nodeModules=new Set([...builtinModules,'electron'])
  const nodeRuntime=name=>name.startsWith('node:')||nodeModules.has(name)
  const findings=[],inventory={platformConsumers:[],bridges:[],endpoints:[],sidecars:[],injection:[],browserImports:[],listeners:[]}
  const asts=new Map([...sources].filter(([f])=>/\.(tsx?|[cm]?js)$/.test(f)&&!f.startsWith('scripts/audit/')).map(([f,t])=>[f,parse(f,t)]))
  function add(file,node,rule,severity,domain,message,affected=['desktop','portable','web-cloud','web-guest']) {
    const unit=asts.get(file),line=unit.getLineAndCharacterOfPosition(node.getStart(unit)).line+1
    const id=crypto.createHash('sha256').update(rule+'\0'+file+'\0'+node.getText(unit)).digest('hex').slice(0,16)
    findings.push({id,rule,severity,domain,owner:policy.owners[domain],file,line,affected,status:'candidate',message})
  }
  function reachable(node,u,context){
    for(let p=node.parent;p;p=p.parent){
      let condition,branch
      if(ts.isConditionalExpression(p)){condition=p.condition;branch=node.pos>=p.whenTrue.pos&&node.end<=p.whenTrue.end}
      else if(ts.isIfStatement(p)){condition=p.expression;branch=node.pos>=p.thenStatement.pos&&node.end<=p.thenStatement.end}
      if(condition){try{const yes=!!safeExpression(condition,u,context);if(yes!==branch)return false}catch{/* Unknown conditions cannot establish reachability. */}}
    }
    return true
  }
  for(const [file,u]of asts){
    const front=file.startsWith('src/'),bindings=new Map()
    for(const s of u.statements)if(ts.isImportDeclaration(s)&&!s.importClause?.isTypeOnly){
      const module=s.moduleSpecifier.text
      const named=s.importClause?.namedBindings
      const typeOnly=named&&ts.isNamedImports(named)&&named.elements.length>0&&named.elements.every(e=>e.isTypeOnly)&&!s.importClause.name
      if(typeOnly)continue
      if(named&&ts.isNamedImports(named))for(const spec of named.elements)if(!spec.isTypeOnly)bindings.set(spec.name.text,spec.propertyName?.text??spec.name.text)
      if(front&&(nodeRuntime(module)||/\/server(?:\/|$)/.test(module))){
        add(file,s,'PLT-01','P1','platform','浏览器共享源码引入Node/Electron/服务端运行时；运行时DESKTOP分支无法隔离静态导入')
        inventory.browserImports.push({file,module})
      }
    }
    const constants=[...bindings].filter(([,v])=>Object.hasOwn(policy.flagSources,v))
    if(constants.length)inventory.platformConsumers.push({file,constants:constants.map(([,v])=>v)})
    visit(u,node=>{
      if(!front&&ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='listen')inventory.listeners.push({file,line:u.getLineAndCharacterOfPosition(node.getStart(u)).line+1,port:node.arguments[0]?.getText(u),host:node.arguments[1]?.getText(u),status:'observed-only'})
      if(front&&ts.isPropertyAccessExpression(node)&&node.expression.getText(u)==='window'&&/^__YFE_(?:WEB|GUEST|PORTABLE)__$/.test(node.name.text)&&!policy.rawFlagAdapters.includes(file))add(file,node,'PLT-02','P2','platform','绕过集中平台判定直接读取注入标记；核对模块求值时机及四种形态')
      let portableCondition=false
      if(ts.isConditionalExpression(node))visit(node.condition,x=>{if(ts.isIdentifier(x)&&(bindings.get(x.text)??x.text)==='PORTABLE')portableCondition=true})
      if(front&&ts.isConditionalExpression(node)&&portableCondition){
        const strings=[];visit(node.whenTrue,x=>{if(ts.isStringLiteralLike(x))strings.push(x.text)})
        const web=profiles.find(p=>p.id==='web-cloud')?.observed??{}
        const context={...web};for(const[local,canonical]of bindings)if(Object.hasOwn(web,canonical))context[local]=web[canonical]
        if(strings.some(s=>/便携|U\s*盘|\.\/data/.test(s))&&reachable(node.whenTrue,u,context))add(file,node,'PLT-03','P2','platform','PORTABLE真分支可能在网页云端显示便携版文案；先判WEB或按能力分支',['web-cloud'])
      }
      if(front&&ts.isCallExpression(node)){
        const call=node.expression.getText(u)
        const module=node.arguments[0]
        if((call==='require'||node.expression.kind===ts.SyntaxKind.ImportKeyword)&&module&&ts.isStringLiteralLike(module)&&nodeRuntime(module.text))add(file,node,'PLT-01','P1','platform','浏览器共享模块动态加载Node/Electron；核对适配器边界，不能用桌面形态推定渲染进程可用Node')
        if(/^window\.electron\w*\./.test(call)){
          inventory.bridges.push({file,call,line:u.getLineAndCharacterOfPosition(node.getStart(u)).line+1})
          if(!policy.bridgeAdapters.includes(file)&&!call.includes('?.'))add(file,node,'PLT-04','P2','platform','组件或业务层直调原生桥；核对能力守卫、无桥降级及是否应收口适配器',['portable','web-cloud','web-guest'])
        }
        if(['fetch','navigator.sendBeacon'].includes(call)){
          const url=node.arguments[0]?.getText(u)??''
          inventory.endpoints.push({file,call,line:u.getLineAndCharacterOfPosition(node.getStart(u)).line+1,urlKind:/\/api\//.test(url)?'application-api':/https?:/.test(url)?'absolute-http':'dynamic'})
          if(/\/api\/(?:data|blob)/.test(url)&&!policy.httpStoreAdapters.includes(file))add(file,node,'PLT-05','P1','persistence','绕过HTTP存储适配层访问数据接口；核对游客禁止远端写及会话/配额错误处理',['portable','web-cloud','web-guest'])
          if(file.startsWith('src/components/')&&/https?:\/\/(?:localhost|127\.0\.0\.1)/.test(url))add(file,node,'PLT-06','P2','network','界面直连固定本机地址，跨形态受HTTPS/CORS/本机服务可达性影响；核对适配与失败提示')
        }
        if(['location.reload','window.location.reload','location.replace','window.location.replace'].includes(call)){
          const scope=node.parent?.parent?.getText(u)??''
          if(/save|restore|import|persist/i.test(scope)&&!/flush|persisted|ensure.*Saved/.test(scope))add(file,node,'PLT-07','P1','persistence','保存/恢复附近刷新或跳转，未见持久化确认条件；await内存put不代表三端均落盘')
        }
      }
      if(file==='server/index.mjs'&&ts.isCallExpression(node)&&/^(?:readUserData|writeUserData|readBlob|writeBlob|deleteBlob|listBlobs)$/.test(node.expression.getText(u))){
        const arg=node.arguments[0]?.getText(u)??''
        if(!/^(?:user|u)\.id$/.test(arg))add(file,node,'PLT-08','P1','identity','账号存储入口首参未见认证用户id；核对是否由客户端指定目录或账号',['web-cloud'])
      }
    })
  }
  for(const entry of policy.sidecars){
    const u=asts.get(entry.file),n=u&&initializer(u,entry.symbol)
    const values=n&&ts.isNewExpression(n)?n.arguments?.[0]:null
    const actual=values&&ts.isArrayLiteralExpression(values)?values.elements.filter(ts.isStringLiteralLike).map(e=>e.text):null
    const matched=actual&&JSON.stringify([...actual].sort())===JSON.stringify([...entry.expected].sort())
    inventory.sidecars.push({...entry,actual,status:matched?'observed-match':'needs-review'})
    if(!matched&&u)add(entry.file,n??u,'PLT-09','P1','persistence','外置store白名单与登记的形态差异不一致；新增存储须同时复核序列化、迁移、导入导出')
  }
  for(const file of ['server/index.mjs','scripts/portable-server.mjs']){
    const flags=new Set(),u=asts.get(file)
    if(u)visit(u,n=>{if(ts.isStringLiteralLike(n)||ts.isTemplateHead(n)||ts.isTemplateMiddle(n)||ts.isTemplateTail(n))for(const m of n.text.matchAll(/window\.(__YFE_\w+__)/g))flags.add(m[1])})
    inventory.injection.push({file,flags:[...flags],status:u?'observed-only':'missing',note:'仅发现源码注入文本，不证明实际响应、分支与执行顺序正确'})
  }
  const server=sources.get('server/index.mjs')??'',portable=sources.get('scripts/portable-server.mjs')??''
  // Deployment scripts are not executed. Their contracts remain runtime evidence requirements.
  inventory.delivery=['scripts/build-desktop.mjs','scripts/build-portable-pkg.mjs','server/deploy.sh','server/scripts/deploy.sh','server/yfe-web.service'].map(file=>({file,present:sources.has(file),status:'unverified'}))
  inventory.sharedHttp=!!server&&!!portable
  const deployFile='server/scripts/deploy.sh',deploy=sources.get(deployFile)
  if(deploy){
    const commands=deploy.split(/\r?\n/).filter(l=>!l.trim().startsWith('#')).join('\n')
    if(commands.includes('/api/ping')&&!/sha256sum|build-info|buildId|sourceFingerprint|version/i.test(commands)){
      const rule='PLT-10',id=crypto.createHash('sha256').update(rule+'\0'+deployFile+'\0'+deploy).digest('hex').slice(0,16)
      findings.push({id,rule,severity:'P2',domain:'delivery',owner:policy.owners.delivery,file:deployFile,line:deploy.split(/\r?\n/).findIndex(l=>l.includes('curl')&&l.includes('/api/ping'))+1,affected:['web-cloud','web-guest'],status:'candidate',message:'发布健康检查只见ping/首页可达，未见版本或构建摘要核对；200不能证明前后端及其他交付形态属于匹配版本'})
    }
  }
  return {findings:[...new Map(findings.map(f=>[f.id,f])).values()],inventory}
}
