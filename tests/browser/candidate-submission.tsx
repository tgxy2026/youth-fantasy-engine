import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import AITemplateFill from '@/components/ai/AITemplateFill'
import InterviewChat from '@/components/creative/InterviewChat'
import {setCurrentProject} from '@/lib/db'
import {loadInterviewArchive,saveInterviewArchive} from '@/lib/creative/interviewStore'
import '@/index.css'

setCurrentProject('candidate-ui-fixture')
const scope='candidate-submission-protocol'
const candidate='<script>window.__candidateScriptRan=true</script>\n'+'候选完整内容\n'.repeat(80)
let behavior:'pending'|'throw'|'decline'|'accept'='pending',calls=0,closes=0,chatCalls=0
let settle:((value:boolean)=>void)|null=null
let chatReply:((value:string)=>void)|null=null
const payloads:Record<string,string>[]=[]
declare global {
  interface Window {
    __candidateUI:{behavior(value:typeof behavior):void;settle(value:boolean):void;counts():{calls:number;closes:number;chatCalls:number};
      payloads():Record<string,string>[];candidate:string;seedArchive():Promise<void>;archive():Promise<unknown>;project(id:string):void;settleChat(value:string):void}
  }
}
window.__candidateUI={behavior:value=>{behavior=value},settle:value=>{settle?.(value);settle=null},counts:()=>({calls,closes,chatCalls}),
  payloads:()=>payloads,candidate,project:setCurrentProject,
  settleChat:value=>{chatReply?.(value);chatReply=null},
  seedArchive:async()=>{await saveInterviewArchive(scope,{state:{turns:[{role:'ai',text:'测试问题'},{role:'user',text:'测试回答'}],
    filled:{'fixture::field':candidate},done:true},updatedAt:Date.now(),applied:false,subject:'采用测试'},'candidate-ui-fixture')},
  archive:()=>loadInterviewArchive(scope,Date.now(),'candidate-ui-fixture')}
async function submit(values:Record<string,string>){
  calls++;payloads.push(values)
  if(behavior==='throw')throw Error('private submission error')
  if(behavior==='decline')return false
  if(behavior==='pending')return new Promise<boolean>(resolve=>{settle=resolve})
  return true
}
const spec={subject:'采用测试',topics:[{key:'main',label:'主题',ask:'测试',fields:['fixture::field']}],allowedKeys:['fixture::field'],labels:{'fixture::field':'候选字段'}}
function Fixture(){
  const [mode,setMode]=useState<'template'|'interview'|null>(null)
  const close=()=>{closes++;setMode(null)}
  return <main className="p-4 min-h-screen bg-surface-app text-content-primary">
    <button onClick={()=>setMode('template')}>打开模板候选</button>
    <button onClick={()=>setMode('interview')}>打开访谈候选</button>
    {mode==='template'&&<AITemplateFill title="模板候选采用测试" fields={[{key:'fixture::field',label:'候选字段'}]} withWorldContext={false} onSubmit={submit} onClose={close}/>}
    {mode==='interview'&&<InterviewChat subject="采用测试" spec={spec} persistScope={scope}
      callChat={async()=>{chatCalls++;return new Promise<string>(resolve=>{chatReply=resolve})}} onApply={submit} onClose={close}/>}
  </main>
}
createRoot(document.getElementById('fixture-root')!).render(<Fixture/> )
