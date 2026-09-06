import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Pool} from 'pg';
import bcrypt from 'bcryptjs';
import {z} from 'zod';
import {managementTransaction} from './management.js';
export function registerReset(app:FastifyInstance,pool:Pool,deps:{requireAdmin:(r:FastifyRequest,p:FastifyReply)=>Promise<{id:string}|null>;invalidateUser:(id:string)=>void}){
 let job={state:'idle',done:0,total:0,message:'',backupId:''};let running=false;
 app.get('/api/admin/reset',async(r,p)=>{if(!await deps.requireAdmin(r,p))return;return job;});
 app.post('/api/admin/reset',async(r,p)=>{
  const admin=await deps.requireAdmin(r,p);if(!admin)return;
  const body=z.object({confirmation:z.literal('重置全部状态'),password:z.string().min(1).max(200)}).parse(r.body);
  if(running)return p.code(409).send({message:'重置正在进行'});
  const account=(await pool.query("SELECT password_hash FROM users WHERE id=$1 AND role='admin'",[admin.id])).rows[0];
  if(!account || !await bcrypt.compare(body.password,account.password_hash))return p.code(403).send({message:'管理员密码错误'});
  if(running)return p.code(409).send({message:'重置正在进行'});
  running=true;job={state:'preparing',done:0,total:0,message:'正在准备初始密码',backupId:''};
  void (async()=>{
   try{
    const students=(await pool.query("SELECT id::text,student_no FROM users WHERE role='student' ORDER BY id")).rows;job.total=students.length;
    const prepared:Array<{id:string;student_no:string;hash:string}>=[];
    for(const s of students){if(s.student_no.length<6)throw Error('学生账号不足六位，无法重置');prepared.push({...s,hash:await bcrypt.hash(s.student_no.slice(-6),11)});job.done++;}
    job.state='applying';job.message='正在备份并重置';
    await managementTransaction(pool,async c=>{
     const current=(await c.query("SELECT id::text,student_no FROM users WHERE role='student' ORDER BY id FOR UPDATE")).rows;
     if(JSON.stringify(current)!==JSON.stringify(students))throw Error('名单在准备期间发生变化，请重新操作');
     await c.query(`CREATE TABLE IF NOT EXISTS registration_reset_backups(id bigserial PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),actor_id bigint NOT NULL,payload jsonb NOT NULL)`);
     const backup=(await c.query(`INSERT INTO registration_reset_backups(actor_id,payload) SELECT $1,jsonb_build_object(
       'students',(SELECT jsonb_agg(to_jsonb(u)) FROM users u WHERE role='student'),
       'enrollments',(SELECT jsonb_agg(to_jsonb(e)) FROM enrollments e),
       'jobs',(SELECT jsonb_agg(to_jsonb(j)) FROM enrollment_jobs j),
       'seats',(SELECT jsonb_agg(to_jsonb(s)) FROM course_seats s)) RETURNING id::text`,[admin.id])).rows[0];
     job.backupId=backup.id;
     await c.query('DELETE FROM enrollment_jobs');await c.query('DELETE FROM enrollments');
     await c.query('UPDATE course_seats SET user_id=NULL WHERE user_id IS NOT NULL');await c.query('UPDATE courses SET enrolled_count=0 WHERE enrolled_count<>0');
     await c.query("DELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE role='student')");
     for(const s of prepared)await c.query('UPDATE users SET password_hash=$1,must_change_password=TRUE,updated_at=now() WHERE id=$2',[s.hash,s.id]);
     await c.query("INSERT INTO audit_logs(actor_id,action,details) VALUES($1,'RESET_ALL_STUDENT_STATES',$2)",[admin.id,JSON.stringify({students:students.length,backupId:backup.id})]);
    });
    for(const s of students)deps.invalidateUser(s.id);
    job.state='complete';job.message='全部学生密码及报名状态已重置，账号限制和课程限额保留';
   }catch(e){job.state='failed';job.message=e instanceof Error?e.message:'重置失败';app.log.error('Student reset failed');}
   finally{running=false;}
  })();
  return p.code(202).send(job);
 });
}
