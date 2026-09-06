import { useEffect, useState } from "react";
import { api } from "./api";
import { formatGmt8 } from "./time";
import { subscribeRefresh } from './manual-refresh';
import { RefreshButton } from './RefreshButton';

type Row = {id:string;name:string;class_name:string;grade:number|null;archived:boolean;course_name:string;course_grade:number|null;status:string;client_sent_at_ms:string|null;received_at:string|null;processed_at:string|null;confirmed_at:string|null};
type Result = {rows:Row[];total:number;page:number;pageSize:number};
const labels:Record<string,string>={SUCCESS:"报名成功",IDEMPOTENT:"已确认",PENDING:"处理中",FULL:"名额已满",CANCELLED:"已取消",COURSE_DISABLED:"课程停用",ALREADY:"已选其他课程",USER_DISABLED:"账号受限",GRADE_MISMATCH:"年级不符",INVALID_USER:"账号不可用"};
labels.WITHDRAWN='已退选';labels.OFFLINE_ONLY='线下报名';
function Time({value,epoch=false}:{value:string|null;epoch?:boolean}) {
  if(value===null)return <span className="muted">—</span>;
  const date=new Date(epoch?Number(value):value);
  if(!Number.isFinite(date.getTime()))return <span className="muted">—</span>;
  return <time dateTime={date.toISOString()}>{formatGmt8(date.getTime())}</time>;
}

export function EnrollmentDetails({courseId}:{courseId?:string}) {
  const [filter,setFilter]=useState({view:"confirmed",grade:"all",query:"",status:"all",page:1});
  const [query,setQuery]=useState("");
  const [result,setResult]=useState<Result>({rows:[],total:0,page:1,pageSize:25});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError("");setResult({rows:[],total:0,page:1,pageSize:25});
    async function load(){
      const params=new URLSearchParams({...filter,page:String(filter.page),...(courseId?{courseId}:{})});
      try {const next=await api<Result>(`/api/admin/enrollment-details?${params}`,{signal:controller.signal});if(!controller.signal.aborted){setResult(next);setError("");}}
      catch(e){if(!controller.signal.aborted)setError((e as Error).message);}
      finally {if(!controller.signal.aborted)setLoading(false);}
    }
    const stop=subscribeRefresh(load);
    return ()=>{controller.abort();stop();};
  },[filter,courseId]);
  return <div className="enrollment-details">
    <div className="filter-cards" aria-label="记录类型">
      <button type="button" className="filter-card tone-green" aria-pressed={filter.view==="confirmed"} onClick={()=>setFilter({...filter,view:"confirmed",status:"all",page:1})}>已确认名单</button>
      <button type="button" className="filter-card tone-blue" aria-pressed={filter.view==="requests"} onClick={()=>setFilter({...filter,view:"requests",page:1})}>报名请求记录</button>
    </div>
    <form className="compact-filters" onSubmit={e=>{e.preventDefault();setFilter({...filter,query:query.trim(),page:1});}}>
      {!courseId && <label>年级<select value={filter.grade} onChange={e=>setFilter({...filter,grade:e.target.value,page:1})}><option value="all">全部年级</option><option value="1">高一</option><option value="2">高二</option><option value="history">历史课程</option></select></label>}
      <label>查找记录<input placeholder="姓名、班级或课程" value={query} maxLength={120} onChange={e=>setQuery(e.target.value)}/></label>
      {filter.view==="requests" && <label>请求结果<select value={filter.status} onChange={e=>setFilter({...filter,status:e.target.value,page:1})}><option value="all">全部结果</option><option value="pending">处理中</option><option value="success">成功</option><option value="failed">未成功 / 已取消</option></select></label>}
      <button type="submit">查询</button><RefreshButton disabled={loading}/>
    </form>
    <p className="muted detail-caption">共 {result.total} 条 · 北京时间，精确到毫秒 · 手动刷新</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="management-table-wrap detail-table-wrap" aria-busy={loading} tabIndex={0} role="region" aria-label="报名明细，可滚动">
      <table className="management-table detail-table"><thead><tr><th>学生 / 班级</th><th>课程 / 结果</th><th>客户端提交</th><th>服务器接收</th><th>{filter.view==="confirmed"?"报名确认":"请求处理"}</th></tr></thead><tbody>
        {result.rows.map(row=><tr key={row.id}>
          <td><strong>{row.name}</strong><small>{row.grade===1?"高一":row.grade===2?"高二":"历史"} · {row.class_name}班{row.archived?" · 已归档":""}</small></td>
          <td><strong>{row.course_name}</strong><span className={`status-chip ${row.status==="PENDING"?"tone-amber":["SUCCESS","IDEMPOTENT"].includes(row.status)?"tone-green":"tone-rose"}`}>{labels[row.status]??row.status}</span></td>
          <td><Time value={row.client_sent_at_ms} epoch/></td><td><Time value={row.received_at}/></td><td><Time value={filter.view==="confirmed"?row.confirmed_at:row.processed_at}/></td>
        </tr>)}
        {!result.rows.length && <tr><td colSpan={5}>{loading?"正在加载…":error?"暂时无法加载记录":"暂无符合条件的记录"}</td></tr>}
      </tbody></table>
    </div>
    <div className="management-pagination"><span>第 {result.page} / {Math.max(1,Math.ceil(result.total/result.pageSize))} 页</span><div className="table-actions"><button className="secondary" disabled={loading||result.page<=1} onClick={()=>setFilter({...filter,page:result.page-1})}>上一页</button><button className="secondary" disabled={loading||result.page*result.pageSize>=result.total} onClick={()=>setFilter({...filter,page:result.page+1})}>下一页</button></div></div>
  </div>;
}

export function ResultPreview(){
  const [open,setOpen]=useState(false);
  return <article className="wide results-panel" id="admin-results" tabIndex={-1}><div className="management-heading"><h2>选课结果</h2><button className="secondary" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?"收起预览":"预览选课结果"}</button></div>
    {[1,2].map(grade=><div className="button-row" key={grade}><a className="button" href={`/api/admin/export/enrollments.csv?grade=${grade}`}>{grade===1?'高一':'高二'}报名明细</a><a className="button secondary" href={`/api/admin/export/courses.csv?grade=${grade}`}>{grade===1?'高一':'高二'}课程人数汇总</a></div>)}
    {open && <EnrollmentDetails/>}
  </article>;
}
