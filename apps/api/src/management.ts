import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { z } from "zod";

function classNumber(name:string) { const match=name.trim().match(/(?:^|[^\d])(\d{1,2})\s*班?$/);return match?Number(match[1]):null; }
const identityInput=z.string().trim().toUpperCase().regex(/^\d{17}[0-9X]$/,"请输入18位身份证号");

export async function managementTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(6754001)");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

function failure(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode });
}

async function student(client: PoolClient, id: string) {
  const result = await client.query("SELECT id::text,student_no,name,class_name,enabled,grade FROM users WHERE id=$1 AND role='student' AND deleted_at IS NULL FOR UPDATE", [id]);
  if (!result.rows[0]) failure("未找到学生", 404);
  return result.rows[0];
}

async function record(client: PoolClient, actorId: string, action: string, details: object) {
  await client.query("INSERT INTO audit_logs(actor_id,action,details) VALUES($1,$2,$3)", [actorId, action, details]);
}

async function revoke(client: PoolClient, id: string) {
  await client.query("DELETE FROM sessions WHERE user_id=$1", [id]);
  await client.query("UPDATE enrollment_jobs SET status='CANCELLED',processed_at=clock_timestamp() WHERE user_id=$1 AND status='PENDING'", [id]);
}

async function releaseEnrollment(client: PoolClient, id: string) {
  const removed = await client.query("DELETE FROM enrollments WHERE user_id=$1 RETURNING id::text,course_id::text", [id]);
  await client.query("UPDATE course_seats SET user_id=NULL WHERE user_id=$1", [id]);
  await client.query("UPDATE enrollment_jobs SET status='CANCELLED',result_enrollment_id=NULL,margin_ms=NULL,processed_at=clock_timestamp() WHERE user_id=$1 AND status IN ('PENDING','SUCCESS','IDEMPOTENT','ALREADY')", [id]);
  await revoke(client, id);
  return removed.rows;
}

const idParams = z.object({ studentId: z.string().regex(/^\d+$/) });
const courseInput = z.object({
  code: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(160),
  teacher: z.string().trim().max(120), location: z.string().trim().max(160),
  description: z.string().trim().max(4000), capacity: z.number().int().min(1).max(2000), enabled: z.boolean()
});

export function registerManagement(app: FastifyInstance, pool: Pool, dependencies: {
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<{ id: string } | null>;
  invalidateUser: (id: string) => void;
}) {
  const { requireAdmin, invalidateUser } = dependencies;

  app.get("/api/admin/courses", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const result = await pool.query(`SELECT c.id::text,c.code,c.name,c.teacher,c.location,c.description,c.capacity,c.enabled,c.grade,
      COUNT(s.user_id)::int AS enrolled_count,(c.capacity-COUNT(s.user_id))::int AS remaining
      FROM courses c LEFT JOIN course_seats s ON s.course_id=c.id GROUP BY c.id ORDER BY c.code`);
    return { courses: result.rows };
  });

  app.put("/api/admin/courses/:courseId", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const { courseId } = z.object({ courseId: z.string().regex(/^\d+$/) }).parse(request.params);
    const body = courseInput.parse(request.body);
    return managementTransaction(pool, async (client) => {
      const before = (await client.query("SELECT * FROM courses WHERE id=$1 FOR UPDATE", [courseId])).rows[0];
      if (!before) failure("未找到课程", 404);
      const occupied = (await client.query("SELECT user_id::text FROM course_seats WHERE course_id=$1 AND user_id IS NOT NULL ORDER BY seat_no", [courseId])).rows.map(r => r.user_id);
      if (body.capacity < occupied.length) failure(`容量不能少于已报名人数（${occupied.length}人）`);
      await client.query(`UPDATE courses SET code=$1,name=$2,teacher=$3,location=$4,description=$5,capacity=$6,enabled=$7,updated_at=NOW() WHERE id=$8`,
        [body.code,body.name,body.teacher,body.location,body.description,body.capacity,body.enabled,courseId]);
      if (before.capacity !== body.capacity) {
        await client.query("DELETE FROM course_seats WHERE course_id=$1", [courseId]);
        await client.query("INSERT INTO course_seats(course_id,seat_no,user_id) SELECT $1,position,user_id FROM unnest($2::bigint[]) WITH ORDINALITY AS seats(user_id,position)", [courseId,occupied]);
        await client.query("INSERT INTO course_seats(course_id,seat_no) SELECT $1,generate_series($2::int,$3::int)", [courseId,occupied.length+1,body.capacity]);
      }
      if (!body.enabled) await client.query("UPDATE enrollment_jobs SET status='COURSE_DISABLED',processed_at=clock_timestamp() WHERE course_id=$1 AND status='PENDING'", [courseId]);
      await record(client, admin.id, "UPDATE_COURSE", { courseId, before: { code:before.code,name:before.name,teacher:before.teacher,location:before.location,description:before.description,capacity:before.capacity,enabled:before.enabled }, after:body });
      return { ok: true };
    });
  });

  app.get("/api/admin/students", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const { query, page, status, enrollment, grade, classNo, passwordState, loginState } = z.object({
      grade:z.enum(["all","1","2"]).default("all"),query:z.string().trim().max(120).default(""),page:z.coerce.number().int().min(1).default(1),
      classNo:z.union([z.literal(""),z.coerce.number().int().min(1).max(99)]).default(""),
      loginState:z.enum(["all","yes","no"]).default("all"),
      passwordState:z.enum(["all","initial","changed"]).default("all"),
      status:z.enum(["all","enabled","disabled"]).default("all"),enrollment:z.enum(["all","selected","unselected","pending"]).default("all")
    }).parse(request.query);
    const where = `u.role='student' AND u.deleted_at IS NULL
      AND ($1='' OR u.id::text=$1 OR lower($1)='id:'||u.id::text OR u.student_no ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%' OR u.class_name ILIKE '%'||$1||'%')
      AND ($2='all' OR u.enabled=($2='enabled'))
      AND ($3='all' OR ($3='selected' AND e.id IS NOT NULL) OR ($3='unselected' AND e.id IS NULL)
        OR ($3='pending' AND EXISTS(SELECT 1 FROM enrollment_jobs j WHERE j.user_id=u.id AND j.status='PENDING')))
      AND ($4='all' OR u.grade::text=$4)
      AND ($5::int IS NULL OR (regexp_match(trim(u.class_name),'(?:^|[^0-9])([0-9]{1,2})\\s*班?$'))[1]::int=$5::int)
      AND ($6='all' OR u.must_change_password=($6='initial')) AND ($7='all' OR EXISTS(SELECT 1 FROM audit_logs a WHERE a.actor_id=u.id AND a.action='LOGIN')=($7='yes'))`;
    const args = [query,status,enrollment,grade,classNo===""?null:classNo,passwordState,loginState];
    const total = Number((await pool.query(`SELECT COUNT(*) FROM users u LEFT JOIN enrollments e ON e.user_id=u.id WHERE ${where}`,args)).rows[0].count);
    const actualPage = Math.min(page,Math.max(1,Math.ceil(total/60)));
    const result = await pool.query(`SELECT u.id::text,u.student_no,u.name,u.class_name,u.grade,u.enabled,u.must_change_password,
      c.name AS course_name,e.id::text AS enrollment_id,e.created_at AS enrolled_at,
      (SELECT COUNT(*)::int FROM enrollment_jobs j WHERE j.user_id=u.id AND j.status='PENDING') AS pending
      FROM users u LEFT JOIN enrollments e ON e.user_id=u.id LEFT JOIN courses c ON c.id=e.course_id
      WHERE ${where} ORDER BY u.student_no,u.id LIMIT 60 OFFSET $8`,[...args,(actualPage-1)*60]);
    return { students:result.rows,total,page:actualPage,pageSize:60 };
  });

  app.get("/api/admin/enrollment-details", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const filter=z.object({
      view:z.enum(["confirmed","requests"]).default("confirmed"),
      grade:z.enum(["all","1","2","history"]).default("all"),
      courseId:z.string().regex(/^\d+$/).optional(),
      query:z.string().trim().max(120).default(""),
      status:z.enum(["all","pending","success","failed"]).default("all"),
      page:z.coerce.number().int().min(1).default(1)
    }).parse(request.query);
    const course=filter.courseId ? (await pool.query("SELECT id::text,name,grade,capacity,enabled FROM courses WHERE id=$1",[filter.courseId])).rows[0] : null;
    if(filter.courseId && !course)return reply.code(404).send({code:"NOT_FOUND",message:"未找到课程"});
    // Keep the three clocks distinct: client submission, server receipt, and confirmation/processing.
    const source=filter.view==="confirmed" ? `SELECT e.id::text,u.name,u.class_name,u.grade,u.deleted_at IS NOT NULL AS archived,
      c.id::text AS course_id,c.name AS course_name,c.grade AS course_grade,'SUCCESS'::text AS status,
      e.client_sent_at_ms,e.created_at AS confirmed_at,j.received_at,j.processed_at
      FROM enrollments e JOIN users u ON u.id=e.user_id JOIN courses c ON c.id=e.course_id
      LEFT JOIN LATERAL (SELECT received_at,processed_at FROM enrollment_jobs WHERE result_enrollment_id=e.id
        AND status='SUCCESS' ORDER BY received_at,id LIMIT 1) j ON TRUE`
      : `SELECT j.id::text,u.name,u.class_name,u.grade,u.deleted_at IS NOT NULL AS archived,
      c.id::text AS course_id,c.name AS course_name,c.grade AS course_grade,j.status,
      j.client_sent_at_ms,e.created_at AS confirmed_at,j.received_at,j.processed_at
      FROM enrollment_jobs j JOIN users u ON u.id=j.user_id JOIN courses c ON c.id=j.course_id
      LEFT JOIN enrollments e ON e.id=j.result_enrollment_id AND e.user_id=j.user_id AND e.course_id=j.course_id`;
    const where=`($1='all' OR ($1='history' AND course_grade IS NULL) OR course_grade::text=$1)
      AND ($2::bigint IS NULL OR course_id::bigint=$2::bigint)
      AND ($3='' OR name ILIKE '%'||$3||'%' OR class_name ILIKE '%'||$3||'%' OR course_name ILIKE '%'||$3||'%')
      AND ($4='all' OR ($4='pending' AND status='PENDING') OR ($4='success' AND status IN ('SUCCESS','IDEMPOTENT'))
        OR ($4='failed' AND status NOT IN ('PENDING','SUCCESS','IDEMPOTENT')))`;
    const args=[filter.grade,filter.courseId??null,filter.query,filter.view==="confirmed"?"all":filter.status];
    const client=await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const total=Number((await client.query(`SELECT COUNT(*) FROM (${source}) details WHERE ${where}`,args)).rows[0].count);
      const page=Math.min(filter.page,Math.max(1,Math.ceil(total/25)));
      const rows=(await client.query(`SELECT * FROM (${source}) details WHERE ${where}
        ORDER BY client_sent_at_ms NULLS LAST,received_at NULLS LAST,id LIMIT 25 OFFSET $5`,[...args,(page-1)*25])).rows;
      await client.query("COMMIT");
      return {rows,total,page,pageSize:25,course};
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  });

  app.post("/api/admin/students", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = z.object({studentNo:identityInput,grade:z.number().int().min(1).max(2),name:z.string().trim().min(1).max(120),className:z.string().trim().max(120).default(""),password:z.string().min(6).max(200).optional(),enabled:z.boolean().optional()}).parse(request.body);
    const password = body.password ?? body.studentNo.slice(-6);
    const number=classNumber(body.className);
    const enabled=body.enabled ?? !(number!=null && number>=1 && number<=4);
    const hash = await bcrypt.hash(password,11);
    const saved = await managementTransaction(pool,async client => {
      const result = await client.query(`INSERT INTO users(student_no,name,class_name,password_hash,role,must_change_password,enabled,grade) VALUES($1,$2,$3,$4,'student',TRUE,$5,$6) RETURNING id::text,student_no,name,class_name,enabled,grade`,[body.studentNo,body.name,body.className,hash,enabled,body.grade]);
      await record(client,admin.id,"ADD_STUDENT",{studentId:result.rows[0].id,studentNo:body.studentNo,name:body.name});
      return result.rows[0];
    });
    return reply.code(201).send({student:saved,initialPassword:password});
  });

  app.post("/api/admin/students/:studentId/reset-password", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const {studentId} = idParams.parse(request.params);
    const body = z.object({password:z.string().min(6).max(200).optional()}).parse(request.body ?? {});
    const target=(await pool.query("SELECT student_no FROM users WHERE id=$1 AND role='student' AND deleted_at IS NULL",[studentId])).rows[0];
    if (!target) failure("未找到学生",404);
    const password = body.password ?? target.student_no.slice(-6);
    const hash = await bcrypt.hash(password,11);
    await managementTransaction(pool,async client => {
      const current=await student(client,studentId);
      if (!body.password && current.student_no!==target.student_no) failure("账号已更新，请重新重置密码");
      await client.query("UPDATE users SET password_hash=$1,must_change_password=TRUE,updated_at=NOW() WHERE id=$2",[hash,studentId]);
      await revoke(client,studentId);
      await record(client,admin.id,"RESET_STUDENT_PASSWORD",{studentId});
    });
    invalidateUser(studentId);
    return {initialPassword:password};
  });

  app.put("/api/admin/students/:studentId/access", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const {studentId} = idParams.parse(request.params);
    const {enabled} = z.object({enabled:z.boolean()}).parse(request.body);
    await managementTransaction(pool,async client => {
      await student(client,studentId);
      await client.query("UPDATE users SET enabled=$1,updated_at=NOW() WHERE id=$2",[enabled,studentId]);
      if (!enabled) await revoke(client,studentId);
      await record(client,admin.id,enabled ? "UNLOCK_STUDENT":"LOCK_STUDENT",{studentId});
    });
    invalidateUser(studentId);
    return {ok:true};
  });

  app.put("/api/admin/students/:studentId",async(request,reply)=>{
    const admin=await requireAdmin(request,reply);if(!admin)return;
    const {studentId}=idParams.parse(request.params);
    const body=z.object({studentNo:identityInput,grade:z.number().int().min(1).max(2),name:z.string().trim().min(1).max(120),className:z.string().trim().max(120),enabled:z.boolean()}).parse(request.body);
    await managementTransaction(pool,async client=>{
      const before=await student(client,studentId);
      if(before.grade!==body.grade && (await client.query("SELECT 1 FROM enrollments WHERE user_id=$1",[studentId])).rowCount)failure("请先清理已选课程，再修改年级");
      await client.query("UPDATE users SET student_no=$1,name=$2,class_name=$3,enabled=$4,grade=$6,updated_at=NOW() WHERE id=$5",[body.studentNo,body.name,body.className,body.enabled,studentId,body.grade]);
      await revoke(client,studentId);
      await record(client,admin.id,"EDIT_STUDENT",{studentId,name:body.name,className:body.className,grade:body.grade,enabled:body.enabled});
    });
    invalidateUser(studentId);return {ok:true};
  });

  app.post("/api/admin/students/class-access",async(request,reply)=>{
    const admin=await requireAdmin(request,reply);if(!admin)return;
    const body=z.object({grade:z.number().int().min(1).max(2).optional(),fromClass:z.number().int().min(1).max(99),toClass:z.number().int().min(1).max(99),enabled:z.boolean()}).refine(v=>v.toClass>=v.fromClass).parse(request.body);
    const ids=await managementTransaction(pool,async client=>{
      const rows=(await client.query("SELECT id::text,class_name FROM users WHERE role='student' AND deleted_at IS NULL AND ($1::smallint IS NULL OR grade=$1)",[body.grade??null])).rows;
      const ids=rows.filter(row=>{const n=classNumber(row.class_name);return n!=null && n>=body.fromClass && n<=body.toClass;}).map(row=>row.id);
      await client.query("UPDATE users SET enabled=$1,updated_at=NOW() WHERE id=ANY($2::bigint[])",[body.enabled,ids]);
      if(!body.enabled){
        await client.query("DELETE FROM sessions WHERE user_id=ANY($1::bigint[])",[ids]);
        await client.query("UPDATE enrollment_jobs SET status='CANCELLED',processed_at=clock_timestamp() WHERE user_id=ANY($1::bigint[]) AND status='PENDING'",[ids]);
      }
      await record(client,admin.id,"CLASS_ACCESS",{...body,count:ids.length});return ids;
    });
    ids.forEach(invalidateUser);return {count:ids.length};
  });

  app.get("/api/admin/confirmations",async(request,reply)=>{
    if(!await requireAdmin(request,reply))return;
    const {courseId}=z.object({courseId:z.string().regex(/^\d+$/).optional()}).parse(request.query);
    const result=await pool.query(`SELECT e.id::text,e.course_id::text,u.id::text AS user_id,u.name,u.class_name,u.grade,c.name AS course_name,
      e.client_sent_at_ms::text,e.created_at AS confirmed_at FROM enrollments e JOIN users u ON u.id=e.user_id JOIN courses c ON c.id=e.course_id
      WHERE u.deleted_at IS NULL AND ($1::bigint IS NULL OR e.course_id=$1) ORDER BY e.course_id,e.client_sent_at_ms,e.id`,[courseId??null]);
    return {confirmations:result.rows};
  });

  app.delete("/api/admin/students/:studentId/enrollment", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const {studentId} = idParams.parse(request.params);
    await managementTransaction(pool,async client => {
      await student(client,studentId);
      const removed = await releaseEnrollment(client,studentId);
      await record(client,admin.id,"CLEAR_STUDENT_ENROLLMENT",{studentId,removed});
    });
    invalidateUser(studentId);
    return {ok:true};
  });

  app.delete("/api/admin/students/:studentId", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const {studentId} = idParams.parse(request.params);
    await managementTransaction(pool,async client => {
      const before = await student(client,studentId);
      const removed = await releaseEnrollment(client,studentId);
      await client.query("UPDATE users SET enabled=FALSE,deleted_at=NOW(),updated_at=NOW() WHERE id=$1",[studentId]);
      await record(client,admin.id,"DELETE_STUDENT",{studentId,studentNo:before.student_no,name:before.name,removed});
    });
    invalidateUser(studentId);
    return {ok:true};
  });
}
