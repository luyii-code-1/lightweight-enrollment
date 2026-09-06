import type { FastifyInstance,FastifyReply,FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { createHash,randomUUID } from "node:crypto";
import { z } from "zod";
import { decodeBase64,decodeRegistrationPacket } from "./protocol.js";
import { managementTransaction } from "./management.js";

type User = {id:string;studentNo:string;role:string;mustChangePassword:boolean;restricted:boolean;grade:number|null};
const error = (message:string,statusCode=409) => Object.assign(new Error(message),{statusCode});

export function registerRegistration(app:FastifyInstance,pool:Pool,deps:{
  requireUser:(request:FastifyRequest,reply:FastifyReply)=>Promise<User|null>;
  verifyChallenge:(userId:string,challengeId:string,answer:number)=>boolean;
  consumeChallenge:(id:string)=>void;
}) {
  async function submit(request:FastifyRequest,reply:FastifyReply) {
    const receivedAt = new Date();
    const user = await deps.requireUser(request,reply);
    if (!user) return;
    if (user.role !== "student") return reply.code(403).send({code:"STUDENTS_ONLY",message:"仅学生可报名"});
    if (user.restricted) return reply.code(403).send({code:"ACCOUNT_RESTRICTED",message:"当前账号仅可查看课程和修改密码"});
    if (!user.grade) return reply.code(403).send({code:"GRADE_REQUIRED",message:"账号尚未设置年级，请联系管理员"});
    let packet;
    try { packet=decodeRegistrationPacket(request.body); } catch { return reply.code(400).send({code:"INVALID_PACKET",message:"报名数据格式或 CRC 校验错误，请重新提交"}); }
    if (packet.identity !== user.studentNo) return reply.code(403).send({code:"IDENTITY_MISMATCH",message:"报名身份与当前登录账号不一致"});
    const body=z.object({challengeId:z.string().uuid(),challengeAnswer:z.number().int()}).parse(request.body);
    const idempotencyKey=z.string().min(8).max(128).parse(request.headers["idempotency-key"]);
    const sessionHash=createHash("sha256").update(request.cookies.selection_session!).digest("hex");
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock_shared(6754001)");
      const valid=await client.query(`SELECT u.id,u.grade FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND u.enabled AND u.deleted_at IS NULL
        AND s.token_hash=$2 AND s.expires_at>clock_timestamp() FOR UPDATE OF u`,[user.id,sessionHash]);
      if (!valid.rowCount) throw error("登录或账号状态已改变，请重新登录",401);
      const previous=await client.query("SELECT id::text,status,course_id::text,client_sent_at_ms::text FROM enrollment_jobs WHERE user_id=$1 AND idempotency_key=$2",[user.id,idempotencyKey]);
      if (previous.rows[0]) {
        const job=previous.rows[0];
        if (job.course_id!==packet.courseId || Number(job.client_sent_at_ms)!==packet.timestamp) throw error("同一请求编号不能修改报名内容");
        await client.query("COMMIT");
        return reply.code(202).send({job});
      }
      if (!deps.verifyChallenge(user.id,body.challengeId,body.challengeAnswer)) throw error("计算验证错误或已过期，请重新验证",400);
      const period=await client.query(`SELECT state='OPEN' AND (opens_at IS NULL OR clock_timestamp()>=opens_at)
        AND (closes_at IS NULL OR clock_timestamp()<closes_at) accepting FROM selection_period WHERE singleton=TRUE`);
      if (!period.rows[0].accepting) throw error("当前不在报名开放时间");
      const course=(await client.query("SELECT online_registration,name FROM courses WHERE id=$1 AND enabled",[packet.courseId])).rows[0];
      if (!course) throw error("课程已停用或不存在");
      if(!course.online_registration || course.name==='线下体验课')throw error("该课程不可在线报名，请线下咨询课程负责老师",403);
      if (!(await client.query("SELECT 1 FROM courses WHERE id=$1 AND grade=$2",[packet.courseId,valid.rows[0].grade])).rowCount) throw error("只能报名本年级的课程",403);
      if ((await client.query("SELECT 1 FROM enrollments WHERE user_id=$1",[user.id])).rowCount) throw error("你已经完成报名");
      if ((await client.query("SELECT 1 FROM enrollment_jobs WHERE user_id=$1 AND status='PENDING'",[user.id])).rowCount) throw error("已有报名请求正在等待结果，请勿重复提交");
      const saved=await client.query(`INSERT INTO enrollment_jobs(id,user_id,course_id,idempotency_key,received_at,client_sent_at_ms)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text,status,course_id::text,client_sent_at_ms::text`,[randomUUID(),user.id,packet.courseId,idempotencyKey,receivedAt,packet.timestamp]);
      await client.query("COMMIT");
      deps.consumeChallenge(body.challengeId);
      return reply.code(202).send({job:saved.rows[0]});
    } catch (cause) {await client.query("ROLLBACK");throw cause;}
    finally {client.release();}
  }
  app.post("/api/enroll/async",submit);
  app.post("/api/enroll",submit);

  app.post("/api/enroll/withdraw",async(request,reply)=>{
    const user=await deps.requireUser(request,reply);
    if(!user)return;
    if(user.role!=="student" || user.restricted)return reply.code(403).send({code:"ACCOUNT_RESTRICTED",message:"当前账号不能退选，请联系管理员"});
    const {enrollmentId}=z.object({enrollmentId:z.string().regex(/^\d+$/)}).parse(request.body);
    const sessionHash=createHash("sha256").update(request.cookies.selection_session!).digest("hex");
    return managementTransaction(pool,async client=>{
      const valid=await client.query(`SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND u.enabled AND u.deleted_at IS NULL
        AND s.token_hash=$2 AND s.expires_at>clock_timestamp() FOR UPDATE OF u`,[user.id,sessionHash]);
      if(!valid.rowCount)throw error("登录或账号状态已改变，请重新登录",401);
      const selected=(await client.query("SELECT id::text,course_id::text FROM enrollments WHERE user_id=$1",[user.id])).rows[0];
      if(!selected)return {ok:true,withdrawn:false};
      if(selected.id!==enrollmentId)throw error("选课记录已更新，请刷新后再退选");
      await client.query("UPDATE course_seats SET user_id=NULL WHERE user_id=$1 AND course_id=$2",[user.id,selected.course_id]);
      await client.query("DELETE FROM enrollments WHERE id=$1 AND user_id=$2",[enrollmentId,user.id]);
      const changed=await client.query(`UPDATE enrollment_jobs SET status='WITHDRAWN',result_enrollment_id=NULL,last_accepted_at_ms=NULL,margin_ms=NULL,processed_at=clock_timestamp()
        WHERE user_id=$1 AND (result_enrollment_id=$2 OR status='PENDING') RETURNING processed_at`,[user.id,enrollmentId]);
      const withdrawnAt=changed.rows[0]?.processed_at ?? (await client.query("SELECT clock_timestamp() AS now")).rows[0].now;
      const course=(await client.query(`SELECT c.id::text,c.capacity,COUNT(s.user_id)::int AS enrolled,(c.capacity-COUNT(s.user_id))::int AS remaining,
        (SELECT MAX(client_sent_at_ms)::text FROM enrollments WHERE course_id=c.id) AS last_accepted_at_ms
        FROM courses c LEFT JOIN course_seats s ON s.course_id=c.id WHERE c.id=$1 GROUP BY c.id`,[selected.course_id])).rows[0];
      await client.query("INSERT INTO audit_logs(actor_id,action,details) VALUES($1,'WITHDRAW_ENROLLMENT',$2)",[user.id,JSON.stringify({enrollmentId,courseId:selected.course_id,withdrawnAt})]);
      return {ok:true,withdrawn:true,withdrawnAt,course};
    });
  });

  app.post("/api/enroll/result",async(request,reply)=>{
    const user=await deps.requireUser(request,reply);
    if (!user) return;
    const {userId}=z.object({userId:z.string().min(4).max(128)}).parse(request.body);
    let identity;
    try {identity=decodeBase64(userId);} catch {return reply.code(400).send({code:"INVALID_IDENTITY",message:"身份编码格式错误"});}
    if (identity!==user.studentNo) return reply.code(403).send({code:"IDENTITY_MISMATCH",message:"只能查询当前登录账号的报名结果"});
    const selected=await pool.query("SELECT course_id::text,client_sent_at_ms::text,created_at FROM enrollments WHERE user_id=$1",[user.id]);
    if (selected.rows[0]) return {status:"SUCCESS",courseId:selected.rows[0].course_id,submittedAtMs:Number(selected.rows[0].client_sent_at_ms),confirmedAt:selected.rows[0].created_at};
    const result=await pool.query(`SELECT status,course_id::text,client_sent_at_ms::text,last_accepted_at_ms::text,processed_at
      FROM enrollment_jobs WHERE user_id=$1 ORDER BY created_at DESC,arrival_order DESC LIMIT 1`,[user.id]);
    const job=result.rows[0];
    return {status:job?.status ?? "NONE",courseId:-1,requestedCourseId:job?.course_id ?? null,submittedAtMs:job?Number(job.client_sent_at_ms):null,
      lastAcceptedAtMs:job?.status==="FULL" && job.last_accepted_at_ms!=null ? Number(job.last_accepted_at_ms):null,confirmedAt:job?.processed_at ?? null};
  });

  // Persisted jobs and confirmations survive process restarts; no overlapping batches.
  let timer:ReturnType<typeof setInterval>|undefined;
  let batch:Promise<unknown>|undefined;
  return {
    start() {
      timer=setInterval(()=>{
        if (batch) return;
        batch=pool.query("SELECT process_enrollment_batch()").catch(cause=>app.log.error({code:cause.code},"registration batch failed")).finally(()=>{batch=undefined;});
      },2000);
    },
    async stop() {if(timer)clearInterval(timer);await batch;}
  };
}
