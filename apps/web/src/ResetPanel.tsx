import {useEffect,useState} from 'react';
import {api} from './api';
type Job={state:string;done:number;total:number;message:string;backupId:string};
export function ResetPanel({onDone}:{onDone:()=>Promise<void>}){
 const [open,setOpen]=useState(false),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[error,setError]=useState('');
 const [job,setJob]=useState<Job|null>(null),[sending,setSending]=useState(false);
 const running=job?.state==='preparing'||job?.state==='applying';
 useEffect(()=>{void api<Job>('/api/admin/reset').then(setJob).catch(e=>setError(e.message));},[]);
 useEffect(()=>{if(!running)return;let active=true;let timer:ReturnType<typeof setTimeout>;
  const load=async()=>{try{const next=await api<Job>('/api/admin/reset');if(!active)return;setJob(next);if(next.state==='complete')await onDone();}catch(e){if(active)setError((e as Error).message);}finally{if(active)timer=setTimeout(load,2000);}};
  timer=setTimeout(load,2000);return()=>{active=false;clearTimeout(timer);};
 },[running]);
 async function submit(e:React.FormEvent){e.preventDefault();if(!confirm('确认重置全部学生密码、报名记录和登录状态？账号限制、课程限额保持不变。'))return;setSending(true);setError('');
  try{setJob(await api<Job>('/api/admin/reset',{method:'POST',body:JSON.stringify({password,confirmation})}));setPassword('');setConfirmation('');setOpen(false);}catch(e){setError((e as Error).message);}finally{setSending(false);}
 }
 return <article className="wide"><div className="management-heading"><h2>学生密码与报名数据</h2><button className="danger subtle-danger" disabled={running||sending} onClick={()=>setOpen(!open)}>重置全部密码和报名数据</button></div>
 <p className="muted">清空报名与待处理记录、释放名额，学生密码恢复身份证后六位并要求改密。保留账号限制、停用状态、管理员、课程限额及报名时间设置。执行前自动保存数据库内备份。</p>
 {open&&<form className="compact-filters" onSubmit={submit}><label>管理员密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><label>输入“重置全部状态”<input value={confirmation} onChange={e=>setConfirmation(e.target.value)} required/></label><button className="danger" disabled={sending||confirmation!=='重置全部状态'}>确认重置</button></form>}
 {job&&job.state!=='idle'&&<p role="status">{job.message}{running?`（${job.done}/${job.total}）`:job.backupId?` · 备份编号 ${job.backupId}`:''}</p>}{error&&<p role="alert">{error}</p>}</article>;
}
