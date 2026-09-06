import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Pool} from 'pg';
import {createHash,randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {z} from 'zod';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function registerPasswordRecovery(app:FastifyInstance,pool:Pool,deps:{secure:boolean;invalidateUser:(id:string)=>void}){
 const attempts=new Map<string,{count:number;until:number}>();
 app.post('/api/auth/forgot-password',async(request,reply)=>{
  const now=Date.now();for(const [k,v] of attempts)if(v.until<=now)attempts.delete(k);
  const ip='ip:'+request.ip,limit=(key:string,max:number)=>{const value=attempts.get(key)??{count:0,until:now+900000};value.count++;attempts.set(key,value);return value.count>max;};
  if(attempts.size>=10000&&!attempts.has(ip)||limit(ip,30))return reply.code(429).header('Retry-After','900').send({message:'重置尝试过多，请15分钟后再试'});
  const body=z.object({name:z.string().trim().min(1).max(120),grade:z.number().int().min(1).max(2),className:z.string().trim().regex(/^\d{1,2}(班)?$/).transform(v=>String(parseInt(v))),identity:z.string().trim().toUpperCase().regex(/^\d{17}[0-9X]$/),newPassword:z.string().min(10).max(200),confirmation:z.string().min(10).max(200)}).refine(v=>v.newPassword===v.confirmation,{message:'两次新密码不一致'}).parse(request.body);
  if(limit('account:'+digest(body.identity),8))return reply.code(429).header('Retry-After','900').send({message:'重置尝试过多，请15分钟后再试'});
  const invalid=()=>reply.code(400).send({message:'姓名、身份证号、年级或班级不匹配，请核对'});
  const found=(await pool.query(`SELECT u.id::text FROM users u WHERE u.role='student' AND u.deleted_at IS NULL AND u.student_no=$1 AND u.name=$2 AND u.grade=$3 AND regexp_replace(u.class_name,'班$','')=$4`,[body.identity,body.name,body.grade,body.className])).rows[0];
  if(!found)return invalid();
  const token=randomBytes(32).toString('base64url'),hash=await bcrypt.hash(body.newPassword,11),client=await pool.connect();
  try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock_shared(6754001)');
   const valid=await client.query(`SELECT u.id FROM users u WHERE u.id=$1 AND u.role='student' AND u.deleted_at IS NULL AND u.student_no=$2 AND u.name=$3 AND u.grade=$4 AND regexp_replace(u.class_name,'班$','')=$5 FOR UPDATE OF u`,[found.id,body.identity,body.name,body.grade,body.className]);
   if(!valid.rowCount){await client.query('ROLLBACK');return invalid();}
   await client.query('UPDATE users SET password_hash=$1,must_change_password=FALSE,updated_at=clock_timestamp() WHERE id=$2',[hash,found.id]);
   await client.query('DELETE FROM sessions WHERE user_id=$1',[found.id]);
   await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '2 hours')",[digest(token),found.id]);
   await client.query("INSERT INTO audit_logs(actor_id,action) VALUES($1,'SELF_RESET_PASSWORD'),($1,'LOGIN')",[found.id]);
   await client.query('COMMIT');deps.invalidateUser(found.id);reply.setCookie('selection_session',token,{httpOnly:true,secure:deps.secure,sameSite:'lax',path:'/',maxAge:7200});return {ok:true};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
}
