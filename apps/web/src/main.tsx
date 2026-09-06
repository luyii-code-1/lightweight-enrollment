import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { api } from "./api";
import { AdminManagement } from "./AdminManagement";
import { ResultPreview } from "./EnrollmentDetails";
import { RateLimitNotice } from "./RateLimitNotice";
import { subscribeRefresh } from "./manual-refresh";
import { registrationPacket } from "./protocol";
import { formatGmt8, gmt8InputToIso, periodLabel } from "./time";
import { CoursePoster } from "./CoursePoster";
import { RefreshButton } from "./RefreshButton";
import { ResetPanel } from './ResetPanel';
import { WatermarkedPage } from './Watermark';
import {ForgotPassword} from './ForgotPassword';
import {TimeSyncPanel} from './TimeSyncPanel';
import {clockReady,type ClockState} from './clock-sync';

type User = { id: string; studentNo: string; name: string; className: string; grade:number|null; role: "student" | "admin"; mustChangePassword: boolean;restricted:boolean };
type Course = { id: string; code: string; name: string; teacher: string; location: string; description: string; capacity: number; grade:number|null; enrolled_count: number; remaining: number; online_registration?:boolean };
type Enrollment = { id: string; course_id?: string; code: string; name: string; teacher: string; location: string; created_at: string };
type Me = { user: User; enrollment: Enrollment | null };
type ServerStatus = { state: string; online: number };
type Challenge = { id: string; left: number; right: number };
type Period = { state: string; opens_at?: string | null; closes_at?: string | null; server_time?: string; accepting?: boolean };
type SignupProgress = { stage: "requesting" | "checking" | "complete" | "failed"; receivedAtMs?: string; marginMs?: number | null; detail?: string };
type RegistrationResult = {status:string;courseId:string|-1;requestedCourseId?:string;submittedAtMs:number|null;lastAcceptedAtMs?:number|null};

function requestKey() {
  const browserCrypto = globalThis.crypto;
  if (browserCrypto?.randomUUID) return browserCrypto.randomUUID();
  if (browserCrypto?.getRandomValues) {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [forgot,setForgot]=useState(false);
  const [studentNo, setStudentNo] = useState("");
  const [password, setPassword] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const authenticatorOnly=false;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ studentNo, ...(!authenticatorOnly ? {password}:{}), ...(totpRequired||authenticatorOnly ? { totpCode } : {}) }) });
      onLogin(await api<Me>("/api/me"));
    } catch (e) {
      if ((e as Error & { code?: string }).code === "TOTP_REQUIRED") setTotpRequired(true);
      else setError((e as Error).message);
    } finally { setBusy(false); }
  }
  if(forgot)return <ForgotPassword onClose={()=>setForgot(false)} onDone={async()=>onLogin(await api<Me>("/api/me"))}/>;
  return <main className="auth-page">
    <div className="auth-brand">轻量报名系统</div>
    <div className="auth-layout">
      <section className="auth-intro" aria-labelledby="site-title">
        <h1 id="site-title">轻量报名系统</h1>
      </section>
      <section className="auth-panel">
        <h2>登录选课</h2>
        <form onSubmit={submit}>
          <label>账号<input autoComplete="username" placeholder="请输入身份证号或管理员账号" value={studentNo} disabled={busy} onChange={(e) => { setStudentNo(e.target.value); setTotpRequired(false); setTotpCode(""); setError(""); }} required /></label>
          {!authenticatorOnly && <label>密码<input type="password" autoComplete="current-password" placeholder="请输入密码" value={password} disabled={busy} onChange={(e) => { setPassword(e.target.value); setTotpRequired(false); setTotpCode(""); setError(""); }} required /></label>}
          {(totpRequired||authenticatorOnly) && <label>动态验证码<input autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="输入验证器中的6位验证码" pattern="[0-9]{6}" maxLength={6} value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))} disabled={busy} required /></label>}
          {error && <p className="form-error" role="alert">{error}</p>}<button className="primary-action" disabled={busy}>{busy ? "正在验证…" : "进入系统"}</button>
        </form>
      </section>
    </div>
    <p className="muted">忘记密码请联系管理员。</p>
    <footer className="auth-footer">Powered By Cloudflare &amp; Rainyun</footer>
  </main>;
}

function ChangePassword({ user, onDone, onLogout }: { user: User; onDone: () => void;onLogout:()=>void }) {
  const [currentPassword, setCurrent] = useState(""); const [newPassword, setNext] = useState(""); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    try { await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }); onDone(); }
    catch (e) { setError((e as Error).message); }
  }
  return <main className="center"><section className="login-card"><h1>你好，{user.name}</h1><p>请核对姓名。首次登录需要修改初始密码。</p><form onSubmit={submit}>
    <label>当前密码<input type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} required /></label>
    <label>新密码（至少10位）<input type="password" minLength={10} value={newPassword} onChange={(e) => setNext(e.target.value)} required /></label>
    {error && <p className="error">{error}</p>}<button>保存新密码</button><button type="button" className="secondary" onClick={onLogout}>姓名不符，退出登录</button>
  </form></section></main>;
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState(""); const [newPassword, setNewPassword] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false); const [complete, setComplete] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setMessage("");
    if (newPassword !== confirmation) { setMessage("两次输入的新密码不一致"); return; }
    setBusy(true);
    try {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setComplete(true); setMessage("密码修改成功，其他设备上的登录已退出。");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="overlay" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="sheet" role="dialog" aria-modal="true" aria-labelledby="password-title"><p className="eyebrow">账号安全</p><h2 id="password-title">修改密码</h2>{complete ? <><p className="success-message">{message}</p><button className="primary-action" onClick={onClose}>完成</button></> : <form className="password-form" onSubmit={submit}><label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required/></label><label>新密码（至少 10 位）<input type="password" autoComplete="new-password" minLength={10} maxLength={200} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required/></label><label>再次输入新密码<input type="password" autoComplete="new-password" minLength={10} maxLength={200} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required/></label>{message && <p className="form-error" role="alert">{message}</p>}<div className="sheet-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存新密码"}</button></div></form>}</section></div>;
}

function Header({ user, onLogout, onChangePassword }: { user: User; onLogout: () => void; onChangePassword: () => void }) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const update = () => api<ServerStatus>("/api/status").then((value) => alive && setStatus(value)).catch(() => {});
    const stop=subscribeRefresh(update);
    return () => { alive = false; stop(); };
  }, []);
return <header className={`app-header${user.role==="admin"?" admin-header":""}`}><div className="brand-lockup"><strong>轻量报名系统</strong></div><div className="header-status" aria-live="polite"><span>当前状态：{status?.state ?? "获取中"}</span><span>同时在线：{status?.online ?? "—"}</span></div><div className="user-area"><RefreshButton/><span>{user.name}<small>{user.role==="student"?`${user.grade===1?"高一":user.grade===2?"高二":"年级待设置"} ${user.className}班`:user.className || user.studentNo}</small></span><button className="text-button" onClick={onChangePassword}>修改密码</button><button className="text-button" onClick={onLogout}>退出</button></div>{user.role==="admin" && <nav className="admin-nav" aria-label="后台分区"><a href="#admin-overview">概览与设置</a><a href="#admin-live">实时报名</a><a href="#admin-courses">课程管理</a><a href="#admin-students">用户列表</a><a href="#admin-results">选课结果</a></nav>}</header>;
}

function StudentApp({ me, refresh, logout }: { me: Me; refresh: () => Promise<void>; logout: () => void }) {
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [courses, setCourses] = useState<Course[]>([]); const [period, setPeriod] = useState<Period>({ state: "DRAFT", accepting: false }); const [message, setMessage] = useState(""); const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState<Course | null>(null); const [waitingVisible, setWaitingVisible] = useState(false); const abortRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<SignupProgress>({ stage: "requesting" });
  const [challenge, setChallenge] = useState<Challenge | null>(null); const [challengeAnswer, setChallengeAnswer] = useState(""); const [challengeLoading, setChallengeLoading] = useState(false);
  const [query, setQuery] = useState(""); const [availableOnly, setAvailableOnly] = useState(false);
  const [clock,setClock]=useState<ClockState|null>(null);
  async function load() {
    const [c, p] = await Promise.all([api<{ courses: Course[] }>("/api/courses"), api<Period>("/api/period")]); setCourses(c.courses); setPeriod(p);
  }
  useEffect(() => {
    let active=true;
    const failed=(error:unknown)=>{if(active && (error as {status?:number}).status!==429)setMessage((error as Error).message);};
    const stopPeriod=subscribeRefresh(()=>api<Period>("/api/period").then(value=>{if(active)setPeriod(value);}),failed);
    const stopCourses=subscribeRefresh(()=>api<{courses:Course[]}>("/api/courses").then(value=>{if(active)setCourses(value.courses);}),failed);
    if(!me.user.restricted && !me.enrollment) {
      api<RegistrationResult>("/api/enroll/result",{method:"POST",body:JSON.stringify({userId:btoa(me.user.studentNo)})}).then(result=>{
        if(active && result.status==="PENDING" && !abortRef.current){
          const controller=new AbortController();abortRef.current=controller;
          setBusy(result.requestedCourseId ?? "pending");setWaitingVisible(true);
          setProgress({stage:"checking",receivedAtMs:String(result.submittedAtMs)});
          void pollResult(controller).finally(()=>{setBusy("");abortRef.current=null;});
        }
      }).catch(()=>{});
    }
    return () => { active=false;stopPeriod();stopCourses();abortRef.current?.abort(); };
  }, [me.user.id,me.user.restricted]);
  async function choose(course: Course) {
    if(course.online_registration===false || course.name==='线下体验课'){window.alert('该课程不可在线报名，请线下咨询课程负责老师');return;}
    if(me.user.restricted || me.enrollment)return;
    setSelected(course); setChallenge(null); setChallengeAnswer(""); setChallengeLoading(true); setMessage("");
    try { setChallenge(await api<Challenge>("/api/enroll/challenge")); }
    catch (e) { setMessage((e as Error).message); setSelected(null); }
    finally { setChallengeLoading(false); }
  }
  const pause = (signal:AbortSignal) => new Promise<void>((resolve,reject)=>{
    if(signal.aborted){reject(new DOMException("Aborted","AbortError"));return;}
    const done=()=>{signal.removeEventListener("abort",cancel);resolve();};
    const timer=window.setTimeout(done,2000);
    const cancel=()=>{window.clearTimeout(timer);reject(new DOMException("Aborted","AbortError"));};
    signal.addEventListener("abort",cancel,{once:true});
  });
  async function pollResult(controller:AbortController) {
    while(!controller.signal.aborted){
      try {
        await pause(controller.signal);
        const result=await api<RegistrationResult>("/api/enroll/result",{method:"POST",body:JSON.stringify({userId:btoa(me.user.studentNo)}),signal:controller.signal});
        if(result.status==="PENDING" || result.status==="NONE")continue;
        if(result.courseId!==-1){setProgress({stage:"complete",receivedAtMs:String(result.submittedAtMs)});await refresh();await load();setWaitingVisible(false);return;}
        const messages:Record<string,string>={WITHDRAWN:"已退选，名额已释放",OFFLINE_ONLY:"该课程不可在线报名，请线下咨询课程负责老师",COURSE_DISABLED:"课程已停用，请选择其他课程",ACCOUNT_UNAVAILABLE:"当前账号无法报名",GRADE_MISMATCH:"课程与账号年级不一致，请重新选择",CANCELLED:"报名请求已由管理员取消",ALREADY:"你已经完成报名"};
        setProgress({stage:"failed",receivedAtMs:String(result.submittedAtMs),
          marginMs:result.status==="FULL" && result.lastAcceptedAtMs!=null && result.submittedAtMs!=null ? result.submittedAtMs-result.lastAcceptedAtMs : null,
          detail:messages[result.status] ?? "课程名额已满"});
        await load();return;
      } catch(cause){
        const failure=cause as Error & {status?:number};
        if(failure.name==="AbortError")return;
        if(failure.status===429)continue;
        if(failure.status && failure.status<500){setProgress({stage:"failed",detail:failure.message});return;}
      }
    }
  }
  async function enroll(course: Course) {
    if(me.user.restricted || me.enrollment || !challenge || Number(challengeAnswer)!==challenge.left+challenge.right)return;
    const timestamp=Math.round(Date.now()+(clock?.offsetMs??0));
    const packet=registrationPacket(me.user.studentNo,course.id,timestamp);
    const idempotencyKey=requestKey();
    const controller=new AbortController();abortRef.current=controller;
    setBusy(course.id);setSelected(null);setWaitingVisible(true);setMessage("");
    setProgress({stage:"requesting",receivedAtMs:String(timestamp)});
    try{
      while(!controller.signal.aborted){
        try{
          await api("/api/enroll/async",{method:"POST",headers:{"Idempotency-Key":idempotencyKey},
            body:JSON.stringify({...packet,challengeId:challenge.id,challengeAnswer:Number(challengeAnswer)}),signal:controller.signal});
          break;
        }catch(cause){
          const failure=cause as Error & {status?:number};
          if(failure.name==="AbortError" || (failure.status && failure.status<500 && failure.status!==429))throw failure;
          await pause(controller.signal);
        }
      }
      setProgress({stage:"checking",receivedAtMs:String(timestamp)});
      await pollResult(controller);
    }catch(cause){
      if((cause as Error).name!=="AbortError"){setProgress({stage:"failed",detail:(cause as Error).message});await refresh().catch(()=>{});}
    }finally{setBusy("");abortRef.current=null;}
  }
  async function withdraw(){
    if(!me.enrollment || me.user.restricted || busy)return;
    if(!window.confirm(`确认退选“${me.enrollment.name}”？名额将立即释放，再次报名需重新排队。`))return;
    setBusy('withdraw');setMessage('');
    try{const result=await api<{withdrawnAt?:string}>('/api/enroll/withdraw',{method:'POST',body:JSON.stringify({enrollmentId:me.enrollment.id})});await refresh();await load();setMessage(`已退选，名额已释放${result.withdrawnAt?` · ${formatGmt8(result.withdrawnAt)}`:''}`);}
    catch(cause){setMessage((cause as Error).message);}finally{setBusy('');}
  }
  const offline=(course:Course)=>course.online_registration===false || course.name==='线下体验课';
  const visibleCourses = courses.filter((course) => (!availableOnly || (!offline(course) && course.remaining > 0)) && `${course.name} ${course.teacher} ${course.code}`.toLowerCase().includes(query.trim().toLowerCase()));
  const periodText = periodLabel(period);
  return <><Header user={me.user} onLogout={logout} onChangePassword={() => setPasswordOpen(true)}/><main className="shell"><div className="page-heading"><div><p className="section-label">{me.user.grade===1?"高一":me.user.grade===2?"高二":""} · 本期课程</p><h1>{me.user.restricted || me.enrollment ? "社团课程列表" : "选择一门社团课"}</h1><p className="muted">{me.user.restricted ? "当前账号仅可查看课程和修改密码，暂不能报名。" : me.enrollment ? "你已完成选课，可继续浏览本期课程。" : "提交后请等待系统确认报名结果。"}</p></div><span className={`state state-${period.state.toLowerCase()}`}><i/>{periodText}</span></div>
    {period.closes_at && <p className="muted">自动截止：{formatGmt8(period.closes_at)}</p>}
    <TimeSyncPanel opensAt={period.opens_at} closesAt={period.closes_at} onChange={setClock}/>
    {me.enrollment && <section className="enrollment-summary" role="status" aria-label="我的选课"><div><strong>已选课程：{me.enrollment.name}</strong><p>{me.enrollment.teacher || "教师待定"} · {me.enrollment.location || "地点待定"}</p><p>确认时间：{formatGmt8(me.enrollment.created_at)}</p></div><button className="secondary" disabled={me.user.restricted || !!busy} onClick={withdraw}>退选课程</button></section>}
    <section className="course-toolbar" aria-label="课程筛选"><label className="search-field"><span>搜索</span><input type="search" placeholder="课程名称、教师或编号" value={query} onChange={(event) => setQuery(event.target.value)}/></label><label className="availability-filter"><input type="checkbox" checked={availableOnly} onChange={(event) => setAvailableOnly(event.target.checked)}/><span>只看有名额</span></label><p>{visibleCourses.length} 门课程</p></section>
    {message && <p className="form-error banner" role="alert">{message}</p>}<div className="course-list">{visibleCourses.map((course, index) => <article className={`course-row ${!offline(course) && course.remaining < 1 ? "full" : ""} ${me.enrollment?.course_id===course.id ? "course-enrolled" : ""}`} key={course.id}><span className="course-number">{String(index + 1).padStart(2,"0")}</span><div className="course-content"><div className="course-title"><span>{course.code}</span><h2>{course.name}</h2></div><p className="course-meta"><span>{course.teacher || "教师待定"}</span><span>{course.location || "地点待定"}</span></p>{course.description && <p className="description">{course.description}</p>}<CoursePoster name={course.name}/></div>{!offline(course) && <div className="seat-status"><strong>{course.remaining > 0 ? course.remaining : 0}</strong><span>剩余名额</span><div className="seat-track" aria-hidden="true"><i style={{width:`${Math.max(0,Math.min(100,(course.remaining/course.capacity)*100))}%`}}/></div></div>}<button className="row-action" disabled={!!busy || (!offline(course) && (!!me.enrollment || me.user.restricted || !period.accepting || course.remaining < 1))} onClick={() => choose(course)}>{offline(course) ? "报名咨询" : me.enrollment?.course_id===course.id ? "已选课程" : me.enrollment || me.user.restricted ? "仅可查看" : course.remaining < 1 ? "已满" : "选择"}</button></article>)}{visibleCourses.length === 0 && <div className="empty-state"><strong>没有符合条件的课程</strong><p>换个关键词，或取消“只看有名额”。</p></div>}</div>
  </main>
  {selected && <div className="overlay" role="presentation" onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}><section className="sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><p className="eyebrow">再次确认</p><h2 id="confirm-title">选择“{selected.name}”</h2><p>{selected.teacher || "教师待定"} · {selected.location || "地点待定"}</p><p className="notice">报名确认后可以退选；退选会立即释放名额，再次报名需重新排队。</p><form className="challenge-form" onSubmit={(event) => { event.preventDefault(); enroll(selected); }}><label htmlFor="challenge-answer">{challengeLoading || !challenge ? "正在生成验证题…" : `请计算：${challenge.left} + ${challenge.right} =`}</label><input id="challenge-answer" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={challengeAnswer} onChange={(event) => setChallengeAnswer(event.target.value)} disabled={!challenge} placeholder="输入答案" autoFocus/><div className="sheet-actions"><button type="button" className="secondary" onClick={() => setSelected(null)}>返回检查</button><button type="submit" disabled={!challenge || Number(challengeAnswer) !== challenge.left + challenge.right}>验证并提交</button></div></form></section></div>}
  {waitingVisible && <div className="overlay waiting" role="status" aria-live="polite"><section className={`sheet waiting-sheet progress-${progress.stage}`}><div className="pulse"><span/><span/><span/></div><h2>{progress.stage === "requesting" ? "正在提交" : progress.stage === "checking" ? "正在等待结果" : progress.stage === "complete" ? "报名完成" : "报名失败"}</h2>{progress.stage === "failed" ? <p>{progress.marginMs != null ? progress.marginMs >= 0 ? `报名失败：该课程已在 ${progress.marginMs}ms 前满员${progress.marginMs === 0 ? "（相同时间戳的最后名额随机抽选）" : ""}` : `报名失败：课程已满员。你的提交时间比最后名额早 ${-progress.marginMs}ms，但请求进入了较晚的处理批次。` : progress.detail}</p> : <p>{progress.receivedAtMs ? `提交时间：${formatGmt8(progress.receivedAtMs)}` : "正在连接报名队列…"}</p>}<button className="secondary" onClick={() => setWaitingVisible(false)}>{progress.stage === "failed" ? "返回课程" : "隐藏提示"}</button></section></div>}
  {passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)}/>}  
  </>;
}

function AdminApp({ me, logout }: { me: Me; logout: () => void }) {
  type LiveData = { courses: Array<{ id: string; code: string; name: string; capacity: number; enrolled: number; remaining: number; grade:number|null; enabled:boolean }>; recent: Array<{ id: string; student_no: string; name: string; course_name: string; status: string; received_at: string; margin_ms?: number }> };
  const [overview, setOverview] = useState({ students: 0, courses: 0, enrolled: 0, capacity: 0, pending: 0, logged_in:0 }); const [period, setPeriod] = useState<Period>({ state: "DRAFT" }); const [message, setMessage] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [live, setLive] = useState<LiveData>({ courses: [], recent: [] }); const [scheduledAt, setScheduledAt] = useState("");
  const [scheduledCloseAt,setScheduledCloseAt]=useState('');
  const [liveGrade,setLiveGrade]=useState(1);
  async function load() {
    const [nextOverview, nextPeriod, nextLive] = await Promise.all([api<typeof overview>("/api/admin/overview"), api<Period>("/api/period"), api<LiveData>("/api/admin/live")]);
    setOverview(nextOverview); setPeriod(nextPeriod); setLive(nextLive);
  }
  useEffect(() => {
    return subscribeRefresh(load,error=>setMessage((error as Error).message));
  }, []);
  async function upload(kind: "students" | "courses", file?: File) {
    if (!file) return; const body = new FormData(); body.append("file", file); setMessage("正在导入…");
    try {
      const result = await api<any>(`/api/admin/${kind}/import`, { method: "POST", body });
      setMessage(`成功导入 ${result.count} 条记录`);
      await load();
    } catch (e) { setMessage((e as Error).message); }
  }
  async function state(next: string, scheduled=false) {
    try {
      const opensAt=scheduled?gmt8InputToIso(scheduledAt):null;
      const closesAt=scheduled?gmt8InputToIso(scheduledCloseAt):null;
      if(opensAt && closesAt && Date.parse(closesAt)<=Date.parse(opensAt))throw new Error('截止时间必须晚于开启时间');
      if(!confirm(next==='CLOSED'?'确认立即停止报名？':scheduled?`确认设置报名时段？\n开启：${opensAt?formatGmt8(opensAt):'立即开启'}\n截止：${closesAt?formatGmt8(closesAt):'手动停止'}`:'确认立即开放报名并清除原有定时设置？'))return;
      await api('/api/admin/period',{method:'PUT',body:JSON.stringify({state:next,opensAt,closesAt})});setMessage(next==='CLOSED'?'报名已停止':scheduled?'报名时段已设置':'报名已开放');await load();
    }
    catch (e) { setMessage((e as Error).message); }
  }
  return <><Header user={me.user} onLogout={logout} onChangePassword={() => setPasswordOpen(true)}/><main className="shell admin-shell" id="admin-overview" tabIndex={-1}><div className="title-row"><div><h1>管理后台</h1><p className="muted">示例学校 · 社团选课管理</p></div><span className={`state ${period.accepting?"state-open":period.state==="CLOSED"?"state-closed":""}`}>{periodLabel(period)}</span></div>{message && <p className="banner" role="status">{message}</p>}
    <section className="stats"><div><b>{overview.students}</b><span>有效学生</span></div><div><b>{overview.courses}</b><span>开课班次</span></div><div><b>{overview.enrolled}</b><span>已报名</span></div><div><b>{overview.pending}</b><span>处理中</span></div><div><b>{overview.capacity}</b><span>总容量</span></div><div><b>{overview.logged_in}</b><span>已登录过</span></div></section>
    <section className="admin-grid">
      <article className="import-panel"><h2>数据导入</h2><p className="muted">学生名单与课程表 · CSV 格式</p><div className="import-actions"><label className="file-button">导入学生<input className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(e) => upload("students", e.target.files?.[0])}/></label><label className="file-button secondary">导入课程<input className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(e) => upload("courses", e.target.files?.[0])}/></label></div><details className="import-format"><summary>查看 CSV 字段要求</summary><p>学生表：身份证、姓名、年级、班级、初始密码（可空，默认后六位）</p><p>课程表：课程编号、课程名称、年级、教师、地点、容量、说明</p></details></article>
      <article className="schedule-panel"><h2>报名时段</h2><p className="muted">{periodLabel(period)}</p><p className="muted">开启：{period.opens_at?formatGmt8(period.opens_at):'手动开启'}<br/>截止：{period.closes_at?formatGmt8(period.closes_at):'手动停止'}</p><div className="button-row"><button onClick={() => state("OPEN")}>立即开放</button><button className="danger subtle-danger" onClick={() => state("CLOSED")}>立即停止</button></div><div className="schedule-controls"><label>自动开启时间（GMT+8）<input type="datetime-local" step="0.001" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)}/></label><label>自动截止时间（GMT+8）<input type="datetime-local" step="0.001" value={scheduledCloseAt} onChange={(event) => setScheduledCloseAt(event.target.value)}/></label><button className="secondary" disabled={!scheduledAt && !scheduledCloseAt} onClick={() => state("OPEN",true)}>保存并启用定时</button></div><p className="notice">可随时停止或重新开放。开启时间留空即立即开启，截止时间留空则手动停止。</p></article>
      <article className="wide live-panel" id="admin-live" tabIndex={-1}><div className="management-heading"><h2>实时报名情况</h2><span className="muted detail-caption">手动刷新</span></div><div className="filter-cards" aria-label="实时报名年级">{[1,2].map(grade=><button className={`filter-card ${grade===1?"tone-blue":"tone-violet"}`} key={grade} aria-pressed={liveGrade===grade} onClick={()=>setLiveGrade(grade)}>高{grade===1?"一":"二"}</button>)}</div><div className="live-course-grid">{live.courses.filter(course=>course.enabled&&course.grade===liveGrade).map(course=><div className={`live-course-cell ${course.remaining===0?"tone-rose":liveGrade===1?"tone-blue":"tone-violet"}`} key={course.id}><span>{course.name}</span>{course.name==="线下体验课"?<small>线下报名</small>:<><strong>{course.enrolled}<small> / {course.capacity}</small></strong><small>剩余 {course.remaining}</small></>}</div>)}</div>{live.recent.length>0 && <details className="recent-requests"><summary>最近报名请求 · {live.recent.length} 条</summary><div className="recent-list">{live.recent.slice(0,8).map(item=><div key={item.id}><span>{item.name}　{item.course_name}</span><time>{formatGmt8(item.received_at)}</time><b>{item.status}</b></div>)}</div></details>}</article>
      <AdminManagement onChanged={load}/>
      <ResetPanel onDone={async()=>{await load();window.dispatchEvent(new Event('selection:manual-refresh'));}}/>
      <ResultPreview/></section>
  </main>{passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)}/>}</>;
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  async function refresh() { setMe(await api<Me>("/api/me")); }
  useEffect(() => {
    let active=true;let timer:number|undefined;
    const load=async()=>{try{const next=await api<Me>("/api/me");if(active)setMe(next);}catch(error){if(!active)return;if((error as {code?:string}).code==="SESSION_RATE_LIMITED")timer=window.setTimeout(load,1000);else setMe(null);}};
    void load();return()=>{active=false;window.clearTimeout(timer);};
  }, []);
  useEffect(()=>{const expired=()=>setMe(null);window.addEventListener("selection:unauthenticated",expired);return()=>window.removeEventListener("selection:unauthenticated",expired);},[]);
  useEffect(() => {
    if (!me) return;
    return subscribeRefresh(refresh,error=>{if((error as {code?:string}).code==="UNAUTHENTICATED")setMe(null);},false);
  }, [me?.user.id]);
  async function logout() { setMe(null); try { await api("/api/auth/logout", { method: "POST" }); } catch {} }
  if (me === undefined) return <main className="center"><p>正在加载…</p></main>;
  if (!me) return <Login onLogin={setMe}/>;
  let page:React.ReactNode;
  if(me.user.role==='admin')page=<AdminApp me={me} logout={logout}/>;
  else page=<StudentApp me={me} refresh={refresh} logout={logout}/>;
  return <WatermarkedPage userId={me.user.id}>{page}</WatermarkedPage>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/><RateLimitNotice/></React.StrictMode>);
