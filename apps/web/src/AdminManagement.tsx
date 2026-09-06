import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { EnrollmentDetails } from "./EnrollmentDetails";
import { subscribeRefresh } from "./manual-refresh";

type Course = { id:string;code:string;name:string;teacher:string;location:string;description:string;capacity:number;grade:number|null;enabled:boolean;enrolled_count:number;remaining:number };
type Student = { id:string;student_no:string;name:string;class_name:string;grade:number|null;enabled:boolean;must_change_password:boolean;course_name:string|null;enrollment_id:string|null;pending:number };
type Students = { students:Student[];total:number;page:number;pageSize:number };
type Filters = { grade:string;query:string;status:string;enrollment:string;classNo:string;passwordState:string;loginState:string;page:number };

function CourseEditor({course,busy,onSave,onCancel}:{course:Course;busy:boolean;onSave:(course:Course)=>void;onCancel:()=>void}) {
  const [draft,setDraft] = useState(course);
  return <form className="management-editor" onSubmit={event=>{event.preventDefault();onSave(draft);}}>
    <h3>编辑课程 · {course.grade===1?"高一":course.grade===2?"高二":"历史课程"} · {course.name}</h3>
    <div className="editor-fields">
      <label>课程编号<input required maxLength={64} value={draft.code} onChange={e=>setDraft({...draft,code:e.target.value})}/></label>
      <label>课程名称<input autoFocus required maxLength={160} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <label>教师<input maxLength={120} value={draft.teacher} onChange={e=>setDraft({...draft,teacher:e.target.value})}/></label>
      <label>地点<input maxLength={160} value={draft.location} onChange={e=>setDraft({...draft,location:e.target.value})}/></label>
      <label>容量（已报名 {course.enrolled_count} 人）<input type="number" min={Math.max(1,course.enrolled_count)} max={2000} required value={draft.capacity} onChange={e=>setDraft({...draft,capacity:Number(e.target.value)})}/></label>
      <label>状态<select value={draft.enabled ? "enabled":"disabled"} onChange={e=>setDraft({...draft,enabled:e.target.value==="enabled"})}><option value="enabled">启用</option><option value="disabled">停用</option></select></label>
      <label className="full-field">课程说明<textarea rows={3} maxLength={4000} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})}/></label>
    </div>
    <div className="button-row"><button disabled={busy}>保存课程</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}

function AddStudent({busy,onSave,onCancel,student}:{busy:boolean;onSave:(body:object)=>void;onCancel:()=>void;student?:Student}) {
  const [draft,setDraft] = useState({studentNo:student?.student_no ?? "",name:student?.name ?? "",className:student?.class_name ?? "",grade:student?.grade ?? 1,password:"",enabled:student?.enabled});
  return <form className="management-editor" onSubmit={event=>{event.preventDefault();onSave({...draft,password:draft.password||undefined});}}>
    <h3>{student ? "修改学生账号":"添加学生"}</h3>
    <div className="editor-fields">
      <label>身份证号<input autoFocus required maxLength={18} pattern="[0-9]{17}[0-9Xx]" value={draft.studentNo} onChange={e=>setDraft({...draft,studentNo:e.target.value.toUpperCase()})}/></label>
      <label>年级<select value={draft.grade} onChange={e=>setDraft({...draft,grade:Number(e.target.value)})}><option value={1}>高一</option><option value={2}>高二</option></select></label>
      <label>姓名<input required maxLength={120} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <label>班级<input maxLength={120} value={draft.className} onChange={e=>setDraft({...draft,className:e.target.value})}/></label>
      {!student && <label>初始密码<input type="password" autoComplete="new-password" minLength={6} maxLength={200} placeholder="留空使用身份证后六位" value={draft.password} onChange={e=>setDraft({...draft,password:e.target.value})}/></label>}
      {student && <label>选课权限<select value={draft.enabled ? "enabled":"restricted"} onChange={e=>setDraft({...draft,enabled:e.target.value==="enabled"})}><option value="enabled">允许报名</option><option value="restricted">仅可查看课程和修改密码</option></select></label>}
    </div>
    <div className="button-row"><button disabled={busy}>{student ? "保存账号":"添加学生"}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}

export function AdminManagement({onChanged}:{onChanged:()=>Promise<void>}) {
  const [courses,setCourses] = useState<Course[]>([]);
  const [courseGrade,setCourseGrade]=useState("1");
  const [courseStatus,setCourseStatus]=useState("all");
  const [courseQuery,setCourseQuery]=useState("");
  const [details,setDetails]=useState<Course|null>(null);
  const [editing,setEditing] = useState<Course|null>(null);
  const [adding,setAdding] = useState(false);
  const [editingStudent,setEditingStudent]=useState<Student|null>(null);
  const [classRange,setClassRange]=useState({fromClass:1,toClass:4,grade:"all"});
  const [students,setStudents] = useState<Students>({students:[],total:0,page:1,pageSize:25});
  const [query,setQuery] = useState("");
  const [filters,setFilters] = useState<Filters>({grade:"all",query:"",status:"all",enrollment:"all",classNo:"",passwordState:"all",loginState:"all",page:1});
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [message,setMessage] = useState("");
  const [credential,setCredential] = useState<{account:string;password:string}|null>(null);
  const requestVersion = useRef(0);
  const loadStudents = useCallback(async()=>{
    const version = ++requestVersion.current;
    const params = new URLSearchParams({...filters,page:String(filters.page)});
    const result = await api<Students>(`/api/admin/students?${params}`);
    if (version === requestVersion.current) {setStudents(result);setLoading(false);}
  },[filters]);
  async function loadCourses() {setCourses((await api<{courses:Course[]}>("/api/admin/courses")).courses);}
  useEffect(()=>{
    setLoading(true);
    const stop=subscribeRefresh(loadStudents,error=>{setMessage((error as Error).message);setLoading(false);});
    return ()=>{stop();requestVersion.current++;};
  },[loadStudents]);
  useEffect(()=>{
    return subscribeRefresh(loadCourses,error=>setMessage((error as Error).message));
  },[]);
  async function change(work:()=>Promise<void>,success:string) {
    if (busy) return;
    setBusy(true);setMessage("");setCredential(null);
    try {
      await work();
      setMessage(success);
      await Promise.all([loadStudents(),loadCourses(),onChanged()]);
    } catch (e) {setMessage((e as Error).message);}
    finally {setBusy(false);}
  }
  function saveCourse(course:Course) {
    if (!course.enabled && editing?.enabled && !confirm(`停用“${course.name}”后停止接收新报名，已有报名保留。确认保存？`)) return;
    void change(async()=>{await api(`/api/admin/courses/${course.id}`,{method:"PUT",body:JSON.stringify(course)});setEditing(null);},"课程已保存");
  }
  function toggleCourse(course:Course) {
    if (!confirm(course.enabled ? `确认停用“${course.name}”？已有报名保留，待处理报名将取消。`:`确认启用“${course.name}”？`)) return;
    void change(async()=>{await api(`/api/admin/courses/${course.id}`,{method:"PUT",body:JSON.stringify({...course,enabled:!course.enabled})});},course.enabled ? "课程已停用":"课程已启用");
  }
  function addStudent(body:object) {
    void change(async()=>{
      const result = await api<{student:Student;initialPassword:string}>("/api/admin/students",{method:"POST",body:JSON.stringify(body)});
      setCredential({account:result.student.student_no,password:result.initialPassword});setAdding(false);
    },"学生已添加，首次登录需要修改密码");
  }
  function resetPassword(student:Student) {
    const password=prompt(`为 ${student.name} 设置新初始密码（至少6位，留空恢复身份证后六位）。确认后将退出当前登录并取消待处理报名，已选课程保留。`,"");
    if(password===null)return;
    if(password && password.length<6){setMessage("初始密码至少6位");return;}
    void change(async()=>{
      const result = await api<{initialPassword:string}>(`/api/admin/students/${student.id}/reset-password`,{method:"POST",body:JSON.stringify({password:password||undefined})});
      setCredential({account:student.student_no,password:result.initialPassword});
    },"密码已重置，请将新密码交给该学生");
  }
  function access(student:Student) {
    if (!confirm(`确认${student.enabled ? "限制选课":"解除限制"} ${student.name}？${student.enabled ? "将取消待处理报名；重新登录后仅可查看课程和修改密码，已有选课保留。":""}`)) return;
    void change(async()=>{await api(`/api/admin/students/${student.id}/access`,{method:"PUT",body:JSON.stringify({enabled:!student.enabled})});},student.enabled ? "账号已限制选课，可重新登录查看课程":"选课限制已解除");
  }
  function editStudent(body:object){
    if(!editingStudent)return;
    void change(async()=>{await api(`/api/admin/students/${editingStudent.id}`,{method:"PUT",body:JSON.stringify(body)});setEditingStudent(null);},"学生账号已更新，需要重新登录");
  }
  function classAccess(enabled:boolean){
    if(!confirm(`确认对 ${classRange.grade==="all"?"高一、高二":classRange.grade==="1"?"高一":"高二"} ${classRange.fromClass}–${classRange.toClass} 班全部学生${enabled ? "解除选课限制":"设置选课限制"}？受限账号可登录查看课程和修改密码。`))return;
    void change(async()=>{const result=await api<{count:number}>("/api/admin/students/class-access",{method:"POST",body:JSON.stringify({...classRange,grade:classRange.grade==="all"?undefined:Number(classRange.grade),enabled})});setMessage(`已处理 ${result.count} 个学生账号`);},enabled ? "班级选课限制已解除":"班级选课限制已设置");
  }
  function clear(student:Student) {
    if (!confirm(`确认清理 ${student.name}（${student.student_no}）的选课？将释放“${student.course_name || "当前课程"}”名额、取消待处理报名并退出登录，学生可在开放期间重新报名。`)) return;
    void change(async()=>{await api(`/api/admin/students/${student.id}/enrollment`,{method:"DELETE"});},"选课状态已清理，名额已释放");
  }
  function remove(student:Student) {
    if (!confirm(`确认删除 ${student.name}（${student.student_no}）？将移出用户列表、封禁登录、取消报名并释放名额。历史记录和账号保留。`)) return;
    void change(async()=>{await api(`/api/admin/students/${student.id}`,{method:"DELETE"});},"用户已删除，历史记录已保留");
  }
  const visibleCourses=courses.filter(course=>(courseGrade==="history"?!course.grade:course.grade===Number(courseGrade)) && (courseStatus==="all"||course.enabled===(courseStatus==="enabled")) && `${course.name} ${course.code} ${course.teacher}`.toLowerCase().includes(courseQuery.trim().toLowerCase()));
  return <>
    <article className="wide course-management" id="admin-courses" tabIndex={-1}>
      <div className="management-heading"><h2>课程管理</h2><span className="muted">{visibleCourses.length} 门课程</span></div>
      <div className="filter-cards" aria-label="课程年级">{[["1","高一","tone-blue"],["2","高二","tone-violet"],["history","历史课程","tone-neutral"]].map(([value,label,tone])=><button key={value} className={`filter-card ${tone}`} aria-pressed={courseGrade===value} onClick={()=>{setCourseGrade(value);setDetails(null);}}>{label}</button>)}</div>
      <div className="compact-filters"><label>查找课程<input value={courseQuery} onChange={e=>setCourseQuery(e.target.value)} placeholder="课程名称、编号或教师"/></label><label>开放状态<select value={courseStatus} onChange={e=>setCourseStatus(e.target.value)}><option value="all">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option></select></label></div>
      {editing && <CourseEditor key={editing.id} course={editing} busy={busy} onSave={saveCourse} onCancel={()=>setEditing(null)}/>}
      {details ? <section className="course-detail-panel" aria-label="课程报名明细"><div className="management-heading"><h3>{details.grade===1?"高一":details.grade===2?"高二":"历史"} · {details.name}</h3><button className="secondary" onClick={()=>setDetails(null)}>返回课程列表</button></div><EnrollmentDetails key={details.id} courseId={details.id}/></section> : <div className="admin-course-cards">
        {visibleCourses.map(course=><section className={`admin-course-card ${!course.enabled?"tone-neutral":course.grade===2?"tone-violet":"tone-blue"}`} key={course.id}>
          <div className="management-heading"><h3>{course.name}</h3><span className={`status-chip ${course.enabled?"tone-green":"tone-neutral"}`}>{course.enabled?"启用":"停用"}</span></div>
          <small className="muted">{course.code}</small><p>{course.teacher || "教师待设置"}</p><p className="muted">{course.location || "地点待设置"}</p>
          {course.name==="线下体验课"?<p className="muted">线下报名 · 课程负责老师</p>:<><div className="course-card-seats"><strong>{course.enrolled_count} / {course.capacity}</strong><span>剩余 {course.remaining}</span></div><progress className="course-fill" value={course.enrolled_count} max={course.capacity} aria-label={`${course.name}报名人数`}/></>}
          <div className="table-actions"><button className="secondary course-detail-action" onClick={()=>setDetails(course)}>报名明细</button><button className="secondary" disabled={busy || !!editing} onClick={()=>setEditing(course)}>编辑</button><button className="secondary" disabled={busy || !!editing} onClick={()=>toggleCourse(course)}>{course.enabled?"停用":"启用"}</button></div>
        </section>)}
        {!visibleCourses.length && <p className="muted">没有符合条件的课程</p>}
      </div>}
    </article>
    <article className="wide student-management" id="admin-students" tabIndex={-1}>
      <div className="management-heading"><div><h2>用户列表</h2><p className="muted">学生账号 · 共 {students.total} 人</p></div><button disabled={busy || adding} onClick={()=>setAdding(true)}>添加用户</button></div>
      {adding && <AddStudent busy={busy} onSave={addStudent} onCancel={()=>setAdding(false)}/>}
      {editingStudent && <AddStudent key={editingStudent.id} student={editingStudent} busy={busy} onSave={editStudent} onCancel={()=>setEditingStudent(null)}/>}
      <details className="batch-access"><summary>按班级批量管理权限</summary><form className="compact-filters" onSubmit={e=>{e.preventDefault();classAccess(false);}}>
        <label>年级<select value={classRange.grade} onChange={e=>setClassRange({...classRange,grade:e.target.value})}><option value="all">高一、高二</option><option value="1">高一</option><option value="2">高二</option></select></label>
        <label>起始班级<input type="number" min={1} max={99} required value={classRange.fromClass} onChange={e=>setClassRange({...classRange,fromClass:Number(e.target.value)})}/></label>
        <label>结束班级<input type="number" min={classRange.fromClass} max={99} required value={classRange.toClass} onChange={e=>setClassRange({...classRange,toClass:Number(e.target.value)})}/></label>
        <button className="secondary" disabled={busy}>批量限制选课</button><button type="button" className="secondary" disabled={busy} onClick={()=>classAccess(true)}>批量解除限制</button>
      </form></details>
      <div className="filter-cards" aria-label="账号状态快捷筛选">{[["all","全部账号","tone-blue"],["enabled","允许报名","tone-green"],["disabled","限制选课","tone-rose"]].map(([value,label,tone])=><button className={`filter-card ${tone}`} key={value} aria-pressed={filters.status===value} onClick={()=>setFilters({...filters,status:value,page:1})}>{label}</button>)}<button className="filter-card tone-blue" aria-pressed={filters.passwordState==="changed"} onClick={()=>setFilters({...filters,passwordState:filters.passwordState==="changed"?"all":"changed",page:1})}>已经改密</button><button className="filter-card tone-green" aria-pressed={filters.enrollment==="selected"} onClick={()=>setFilters({...filters,enrollment:filters.enrollment==="selected"?"all":"selected",page:1})}>已报名</button></div>
      <form className="compact-filters student-filters" onSubmit={e=>{e.preventDefault();setFilters({...filters,query:query.trim(),page:1});}}>
        <label>年级<select value={filters.grade} onChange={e=>setFilters({...filters,grade:e.target.value,page:1})}><option value="all">全部年级</option><option value="1">高一</option><option value="2">高二</option></select></label>
        <label>班级<input type="number" min={1} max={99} value={filters.classNo} onChange={e=>setFilters({...filters,classNo:e.target.value,page:1})} placeholder="全部班级"/></label>
        <label>查找用户<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ID:123、身份证号、姓名或班级" maxLength={120}/></label>
        <label>账号状态<select value={filters.status} onChange={e=>setFilters({...filters,status:e.target.value,page:1})}><option value="all">全部账号</option><option value="enabled">允许报名</option><option value="disabled">限制选课</option></select></label>
        <label>选课状态<select value={filters.enrollment} onChange={e=>setFilters({...filters,enrollment:e.target.value,page:1})}><option value="all">全部学生</option><option value="selected">已选课</option><option value="unselected">未选课</option><option value="pending">处理中</option></select></label>
        <label>密码状态<select value={filters.passwordState} onChange={e=>setFilters({...filters,passwordState:e.target.value,page:1})}><option value="all">全部</option><option value="initial">未改密</option><option value="changed">已改密</option></select></label>
        <label>登录状态<select value={filters.loginState} onChange={e=>setFilters({...filters,loginState:e.target.value,page:1})}><option value="all">全部</option><option value="yes">已登录过</option><option value="no">未登录过</option></select></label><div className="table-actions"><button disabled={busy}>查询</button><button type="button" className="secondary" onClick={()=>{setQuery("");setFilters({grade:"all",query:"",classNo:"",status:"all",enrollment:"all",passwordState:"all",loginState:"all",page:1});}}>重置筛选</button></div>
      </form>
      <div className="student-grid" aria-busy={loading}>
        {students.students.map(student=><section className="student-compact" key={student.id}>
          <div className="student-identity"><strong>{student.name}</strong><small>ID：{student.id} · {student.grade===1?'高一':student.grade===2?'高二':'历史'} {student.class_name}班</small></div>
          <div className="student-statuses"><span className={`status-chip ${student.enabled?'tone-green':'tone-rose'}`}>{student.enabled?'可报名':'受限'}</span><span className={`status-chip ${student.must_change_password?'tone-neutral':'tone-blue'}`}>{student.must_change_password?'未改密':'已改密'}</span><span className={`status-chip ${student.course_name?'tone-green':student.pending?'tone-amber':'tone-neutral'}`} title={student.course_name??undefined}>{student.course_name?'已报名':student.pending?'处理中':'未报名'}</span></div>
          <details className="student-actions"><summary>操作</summary><div className="student-action-menu"><small>{student.student_no}</small>{student.course_name&&<small>{student.course_name}</small>}
            <button className="secondary" disabled={busy || !!editingStudent} onClick={()=>setEditingStudent(student)}>编辑账号</button>
            <button className="secondary" disabled={busy} onClick={()=>resetPassword(student)}>重置密码</button>
            <button className="secondary" disabled={busy || (!student.enrollment_id && !student.pending)} onClick={()=>clear(student)}>清理选课</button>
            <button className="secondary" disabled={busy} onClick={()=>access(student)}>{student.enabled?'限制选课':'解除限制'}</button>
            <button className="danger subtle-danger" disabled={busy} onClick={()=>remove(student)}>删除</button>
          </div></details>
        </section>)}
        {!students.students.length&&<p>{loading?'正在加载用户…':'没有符合条件的用户'}</p>}
      </div>
      <div className="management-pagination"><span>第 {students.page} / {Math.max(1,Math.ceil(students.total/students.pageSize))} 页</span><div className="table-actions"><button className="secondary" disabled={busy || loading || students.page<=1} onClick={()=>setFilters({...filters,page:students.page-1})}>上一页</button><button className="secondary" disabled={busy || loading || students.page*students.pageSize>=students.total} onClick={()=>setFilters({...filters,page:students.page+1})}>下一页</button></div></div>
    </article>
    {(message || credential) && <article className="wide management-feedback" role="status"><p>{message}</p>{credential && <div><p>账号：{credential.account}　新初始密码：<code>{credential.password}</code></p><button className="secondary" onClick={()=>setCredential(null)}>隐藏密码</button></div>}</article>}
  </>;
}
