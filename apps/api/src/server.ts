import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import bcrypt from "bcryptjs";
import { parse } from "csv-parse/sync";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg, { PoolClient } from "pg";
import { z } from "zod";
import { csv } from "./utils.js";
import { verifyTotp } from "./totp.js";
import { managementTransaction, registerManagement } from "./management.js";
import {registerPasswordRecovery} from './password-recovery.js';
import { registerRegistration } from "./registration.js";
import { registerSecurity } from "./security.js";
import { SessionRateLimiter, clientKey, refreshWarning, type RateDecision } from "./session-rate-limit.js";
import { registerReset } from './reset.js';

const config = z.object({
  PORT: z.coerce.number().int().positive().default(6754),
  DATABASE_URL: z.string().min(1),
  COOKIE_SECRET: z.string().min(32),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8),
  ADMIN_TOTP_SECRET: z.string().regex(/^([A-Z2-7]{32})?$/).default(""),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173,http://localhost:6754"),
  TRUSTED_PROXIES: z.string().default(""),
  COOKIE_SECURE: z.string().default("true").transform((value) => value !== "false"),
  DB_POOL_MAX: z.coerce.number().int().min(4).max(64).default(16)
}).parse(process.env);

const allowedOrigins = new Set(config.ALLOWED_ORIGINS.split(",").map((v) => new URL(v.trim()).origin));
if(config.COOKIE_SECURE && [...allowedOrigins].some(origin=>!origin.startsWith("https://")))throw new Error("Secure deployments require HTTPS origins");
const trustedProxies=config.TRUSTED_PROXIES.split(",").map(value=>value.trim()).filter(Boolean);
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
const app = Fastify({ logger: true, disableRequestLogging: true, bodyLimit: 2 * 1024 * 1024, trustProxy: trustedProxies.length?trustedProxies:false });
const SESSION_COOKIE = "selection_session";
const SESSION_SECONDS = 7200;
const sessionRates=new SessionRateLimiter();

type CurrentUser = {
  id: string;
  studentNo: string;
  name: string;
  className: string;
  grade: number | null;
  role: "student" | "admin";
  mustChangePassword: boolean;
  restricted: boolean;
};

const authenticatedRequests = new WeakMap<FastifyRequest, CurrentUser>();
const activeUsers = new Map<string, number>();
const challenges = new Map<string, { userId: string; answer: number; expiresAt: number }>();

function invalidateUser(id: string) {
  sessionRates.revokeUser(id);
  for (const [challengeId, challenge] of challenges) if (challenge.userId === id) challenges.delete(challengeId);
  activeUsers.delete(id);
}

function markActive(userId: string) {
  const now = Date.now();
  activeUsers.set(userId, now);
  for (const [id, seenAt] of activeUsers) if (seenAt < now - 120_000) activeUsers.delete(id);
}

function verifyChallenge(userId: string, challengeId: string, answer: number) {
  const challenge = challenges.get(challengeId);
  if (!challenge || challenge.userId !== userId || challenge.expiresAt < Date.now() || challenge.answer !== answer) {
    return false;
  }
  return true;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function migrate() {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
  const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 11);
  await pool.query(
    `INSERT INTO users(student_no, name, class_name, password_hash, must_change_password, role, totp_secret)
     VALUES($1, '系统管理员', '管理', $2, FALSE, 'admin', $3)
     ON CONFLICT(student_no) DO NOTHING`,
    [config.ADMIN_USERNAME, passwordHash, config.ADMIN_TOTP_SECRET || null]
  );
}

async function currentUser(request: FastifyRequest): Promise<CurrentUser | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const hash = tokenHash(token);
  const result = await pool.query(
    `SELECT u.id::text, u.student_no, u.name, u.class_name, u.role, u.must_change_password, u.enabled, u.grade, s.expires_at
       FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.deleted_at IS NULL`,
    [hash]
  );
  const row = result.rows[0];
  if (!row) {sessionRates.forget(clientKey(hash,request.ip,request.headers['user-agent']??''));return null;}
  sessionRates.register(clientKey(hash,request.ip,request.headers['user-agent']??''),row.id,new Date(row.expires_at).getTime());
  const user: CurrentUser = {
    id: row.id,
    studentNo: row.student_no,
    name: row.name,
    className: row.class_name,
    grade: row.grade,
    role: row.role,
    mustChangePassword: row.must_change_password,
    restricted: row.role === "student" && !row.enabled
  };
  return user;
}

async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = authenticatedRequests.get(request) ?? await currentUser(request);
  if (!user) {
    await reply.code(401).send({ code: "UNAUTHENTICATED", message: "请先登录" });
    return null;
  }
  markActive(user.id);
  return user;
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = await requireUser(request, reply);
  if (!user) return null;
  if (user.role !== "admin") {
    await reply.code(403).send({ code: "FORBIDDEN", message: "需要管理员权限" });
    return null;
  }
  return user;
}

async function audit(client: PoolClient | pg.Pool, actorId: string | null, action: string, details: object = {}) {
  await client.query("INSERT INTO audit_logs(actor_id, action, details) VALUES($1,$2,$3)", [actorId, action, details]);
}

await app.register(cookie);
registerSecurity(app,allowedOrigins,config.COOKIE_SECURE);
await app.register(cors, {
  credentials: true,
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  }
});
await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 1 } });

app.addHook("onRequest", async (request, reply) => {
  const pathname = request.url.split("?")[0];
  const hash=request.cookies[SESSION_COOKIE] ? tokenHash(request.cookies[SESSION_COOKIE]!) : null;
  const key=hash?clientKey(hash,request.ip,request.headers['user-agent']??''):null;
  const document=request.method==='GET' && ['/', '/server', '/server/', '/index.html'].includes(pathname??'');
  const ratePage=(message:string)=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问提示</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f2;font:18px/1.6 sans-serif"><main style="max-width:36rem;padding:2rem;text-align:center"><h1 style="font-size:24px">${message}</h1><a href="/">返回系统</a></main></body></html>`;
  const rejectRate=(decision:RateDecision)=>{
    reply.code(429).header('Retry-After',decision.retryAfter).header('Cache-Control','no-store');
    if(request.raw.httpVersionMajor===1)reply.header('Connection','close');
    return document?reply.type('text/html').send(ratePage(`访问已暂停，请 ${decision.retryAfter} 秒后重试`)):reply.send({code:'SESSION_RATE_LIMITED',message:`请求过于频繁，请等待 ${decision.retryAfter} 秒后重试`,retryAfter:decision.retryAfter});
  };
  if(document && key){
    const user=await currentUser(request);
    if(user){const rate=sessionRates.check(key,true);if(rate?.retryAfter)return rejectRate(rate);if(rate?.warning)return reply.type('text/html').header('Cache-Control','no-store').send(ratePage(refreshWarning));}
  }
  if (pathname?.startsWith("/api/") && !["/api/auth/login","/api/auth/forgot-password"].includes(pathname) && request.method !== "OPTIONS") {
    const exempt=pathname==="/api/auth/logout";
    let rate=key && !exempt ? sessionRates.check(key,false):null;
    if(rate?.retryAfter)return rejectRate(rate);
    const user = await currentUser(request);
    if (!user) return reply.code(401).send({ code:"UNAUTHENTICATED", message:"登录已失效或已在其他设备登录，请重新登录" });
    // Concurrent first requests count after authentication as well.
    if(!rate && key && !exempt)rate=sessionRates.check(key,false);
    if(rate?.retryAfter)return rejectRate(rate);
    if(rate?.warning)reply.header("X-Session-Rate-Warning","1");
    authenticatedRequests.set(request,user);
    reply.header("Cache-Control","no-store");
    const readonlyRoutes = new Set(["/api/me","/api/courses","/api/period","/api/status","/api/time","/api/auth/change-password","/api/auth/logout"]);
    if (user.restricted && !readonlyRoutes.has(pathname)) return reply.code(403).send({code:"ACCOUNT_RESTRICTED",message:"当前账号仅可查看课程和修改密码"});
  }
});

app.get("/api/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true, time: new Date().toISOString() };
});
app.get('/api/admin/telemetry-auth',async(request,reply)=>{if(!await requireAdmin(request,reply))return;return reply.code(204).send();});
app.get('/server',async(_request,reply)=>reply.redirect('/goaccess/'));
app.get('/server/',async(_request,reply)=>reply.redirect('/goaccess/'));
app.get('/api/time',async()=>({serverTimeMs:Date.now(),source:'aliyun-ntp'}));

app.get("/api/status", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const now = Date.now();
  for (const [id, seenAt] of activeUsers) if (seenAt < now - 120_000) activeUsers.delete(id);
  const pending = Number((await pool.query("SELECT COUNT(*)::int AS count FROM enrollment_jobs WHERE status='PENDING'")).rows[0].count);
  const cpuLoad = (loadavg()[0] ?? 0) / Math.max(1, availableParallelism());
  const memoryLoad = 1 - freemem() / totalmem();
  const pressure = Math.max(cpuLoad, memoryLoad * 0.8, pending / 120);
  const state = pressure < 0.55 ? "流畅" : pressure < 0.9 ? "良好" : pressure < 1.3 ? "繁忙" : "拥挤";
  return { state, online: activeUsers.size };
});

app.get("/api/enroll/challenge", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  if (user.role !== "student") return reply.code(403).send({ code: "STUDENTS_ONLY", message: "仅学生可选课" });
  const left = 10 + Math.floor(Math.random() * 90);
  const right = 10 + Math.floor(Math.random() * 90);
  const id = randomUUID();
  const now = Date.now();
  for (const [key, challenge] of challenges) if (challenge.expiresAt < now) challenges.delete(key);
  challenges.set(id, { userId: user.id, answer: left + right, expiresAt: now + 5 * 60_000 });
  return { id, left, right };
});

const attempts = new Map<string, { count: number; resetAt: number }>();
app.post("/api/auth/login", async (request, reply) => {
  const body = z.object({ studentNo: z.string().trim().min(1).max(64).transform(value => /^\d{17}[0-9xX]$/.test(value) ? value.toUpperCase() : value), password: z.string().max(200).optional(), totpCode: z.string().max(64).optional() }).parse(request.body);
  const authenticatorOnly=false;
  const account=authenticatorOnly?config.ADMIN_USERNAME:body.studentNo;
  const now = Date.now();
  const key = account.toLowerCase();
  const entry = attempts.get(key);
  if (entry && entry.resetAt > now && entry.count >= 8) {
    return reply.code(429).send({ code: "TOO_MANY_ATTEMPTS", message: "登录尝试过多，请15分钟后再试" });
  }
  const result = await pool.query("SELECT * FROM users WHERE student_no=$1 AND deleted_at IS NULL", [account]);
  const row = result.rows[0];
  if (!row || (authenticatorOnly ? row.role!=='admin'||!row.enabled||!row.totp_secret : !body.password||!(await bcrypt.compare(body.password, row.password_hash)))) {
    const current = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + 15 * 60_000 };
    current.count += 1;
    attempts.set(key, current);
    return reply.code(401).send({ code: "INVALID_CREDENTIALS", message: "账号或密码错误" });
  }
  const loginClient = await pool.connect();
  let loginCommitted = false;
  try {
  await loginClient.query("BEGIN");
  await loginClient.query("SELECT pg_advisory_xact_lock_shared(6754001)");
  const stillValid = await loginClient.query("SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL AND password_hash=$2", [row.id,row.password_hash]);
  if (!stillValid.rows[0]) return reply.code(401).send({ code:"INVALID_CREDENTIALS", message:"账号状态已改变，请重新登录" });
  Object.assign(row,stillValid.rows[0]);
  if(authenticatorOnly && (row.role!=='admin'||!row.enabled||!row.totp_secret))return reply.code(401).send({code:'INVALID_CREDENTIALS',message:'管理员验证器登录不可用'});
  if (row.totp_secret) {
    if (body.totpCode === undefined) {
      return reply.code(401).send({ code: "TOTP_REQUIRED", message: "请输入验证器中的6位验证码" });
    }
    const step = verifyTotp(row.totp_secret, body.totpCode);
    const consumed = step === null ? null : await loginClient.query(
      `UPDATE users SET totp_last_step=$1 WHERE id=$2 AND totp_last_step<$1
       AND enabled=TRUE AND password_hash=$3 AND totp_secret=$4 RETURNING id`,
      [step, row.id, row.password_hash, row.totp_secret]
    );
    if (!consumed?.rowCount) {
      const latest = attempts.get(key);
      const current = latest && latest.resetAt > now ? latest : { count: 0, resetAt: now + 15 * 60_000 };
      current.count += 1;
      attempts.set(key, current);
      return reply.code(401).send({ code: "INVALID_TOTP", message: "验证码错误、已过期或已使用，请输入最新验证码" });
    }
  }
  attempts.delete(key);
  const token = randomBytes(32).toString("base64url");
  await loginClient.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+INTERVAL '2 hours')
     ON CONFLICT(user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,created_at=clock_timestamp()`,
    [tokenHash(token), row.id]
  );
  const loggedInUser: CurrentUser = {
    id: String(row.id), studentNo: row.student_no, name: row.name, className: row.class_name, grade:row.grade,
    role: row.role, mustChangePassword: row.must_change_password, restricted:row.role === "student" && !row.enabled
  };
  await audit(loginClient, String(row.id), "LOGIN");
  await loginClient.query("COMMIT");
  loginCommitted = true;
  sessionRates.revokeUser(String(row.id));
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_SECONDS
  });
  return { user: loggedInUser };
  } finally {
    if (!loginCommitted) {
      await loginClient.query("ROLLBACK");
    }
    loginClient.release();
  }
});

app.post("/api/auth/logout", async (request, reply) => {
  const token = request.cookies[SESSION_COOKIE];
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, secure: config.COOKIE_SECURE, sameSite: "lax" });
  if (token) {
    const hash = tokenHash(token);
    try {
      await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hash]);
      sessionRates.forget(clientKey(hash,request.ip,request.headers['user-agent']??''));
    } catch (error) {
      app.log.error(error, "failed to remove logged-out session from database");
    }
  }
  return { ok: true };
});

app.get("/api/me", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const enrollment = await pool.query(
    `SELECT e.id::text, e.created_at, c.id::text AS course_id, c.code, c.name, c.teacher, c.location
       FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=$1`,
    [user.id]
  );
  return { user, enrollment: enrollment.rows[0] ?? null };
});

app.post("/api/auth/change-password", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const body = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) }).parse(request.body);
  const result = await pool.query("SELECT password_hash FROM users WHERE id=$1", [user.id]);
  if (!(await bcrypt.compare(body.currentPassword, result.rows[0].password_hash))) {
    return reply.code(400).send({ code: "WRONG_PASSWORD", message: "当前密码错误" });
  }
  const hash = await bcrypt.hash(body.newPassword, 11);
  const currentHash = tokenHash(request.cookies[SESSION_COOKIE]!);
  await managementTransaction(pool,async client => {
    const valid = await client.query(`SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND u.deleted_at IS NULL
      AND u.password_hash=$2 AND s.token_hash=$3 AND s.expires_at>NOW()`,[user.id,result.rows[0].password_hash,currentHash]);
    if (!valid.rowCount) throw Object.assign(new Error("账号状态已改变，请重新登录"),{statusCode:401});
    await client.query("UPDATE users SET password_hash=$1,must_change_password=FALSE,updated_at=NOW() WHERE id=$2",[hash,user.id]);
    await client.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",[user.id,currentHash]);
    await audit(client,user.id,"CHANGE_PASSWORD");
  });
  invalidateUser(user.id);
  return { ok: true };
});

app.get("/api/period", async () => {
  const result = await pool.query(`SELECT state,opens_at,closes_at,clock_timestamp() AS server_time,
    state='OPEN' AND (opens_at IS NULL OR clock_timestamp()>=opens_at) AND (closes_at IS NULL OR clock_timestamp()<closes_at) AS accepting
    FROM selection_period WHERE singleton=TRUE`);
  return result.rows[0];
});

app.get("/api/courses", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const result = await pool.query(
    `SELECT c.id::text,c.code,c.name,c.teacher,c.location,c.description,c.capacity,c.grade,(c.online_registration AND c.name<>'线下体验课') AS online_registration,
            COUNT(s.user_id)::int AS enrolled_count,
            (c.capacity-COUNT(s.user_id))::int AS remaining
       FROM courses c LEFT JOIN course_seats s ON s.course_id=c.id WHERE c.enabled AND ($1::boolean OR c.grade=$2)
      GROUP BY c.id ORDER BY c.code`, [user.role==="admin",user.grade]
  );
  return { courses: result.rows };
});

const registration = registerRegistration(app,pool,{ requireUser,verifyChallenge,consumeChallenge:(id)=>challenges.delete(id) });

async function uploadedCsv(request: FastifyRequest) {
  const part = await request.file();
  if (!part) throw Object.assign(new Error("请选择CSV文件"), { statusCode: 400 });
  return parse((await part.toBuffer()).toString("utf8"), { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
}

function pick(row: Record<string, string>, ...names: string[]) {
  for (const name of names) if (row[name] != null) return row[name]!.trim();
  return "";
}

async function ensureEditable(reply: FastifyReply) {
  const result = await pool.query("SELECT state FROM selection_period WHERE singleton=TRUE");
  if (["OPEN", "CLOSED"].includes(result.rows[0].state)) {
    await reply.code(409).send({ code: "CONFIG_FROZEN", message: "选课开放后配置不可修改" });
    return false;
  }
  return true;
}

async function lockImport(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(6754001)");
  const result = await client.query("SELECT state FROM selection_period WHERE singleton=TRUE FOR SHARE");
  if (["OPEN","CLOSED"].includes(result.rows[0].state)) throw Object.assign(new Error("批量导入仅限报名开放前"), { statusCode:409 });
}

app.post("/api/admin/students/import", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin) return;
  const rows = await uploadedCsv(request);
  if (rows.length > 2000) return reply.code(400).send({ code: "TOO_MANY_ROWS", message: "单次最多导入2000人" });
  const normalized = rows.map((row, index) => {
    const studentNo = pick(row, "身份证", "身份证号", "student_no", "学号").toUpperCase();
    const name = pick(row, "name", "姓名");
    if (!/^\d{17}[0-9X]$/.test(studentNo) || !name) throw Object.assign(new Error(`第${index + 2}行身份证号或姓名格式不正确`),{statusCode:400});
    const className=pick(row,"class_name","班级");
    const classMatch=className.match(/(?:^|[^\d])(\d{1,2})\s*班?$/);
    const classNumber=classMatch?Number(classMatch[1]):0;
    const gradeText=pick(row,"年级","grade");
    const grade=({"高一":1,"高二":2,"1":1,"2":2} as Record<string,number>)[gradeText];
    if(!grade) throw Object.assign(new Error(`第${index+2}行需填写年级（高一/高二）`),{statusCode:400});
    return {studentNo,name,className,grade,enabled:!(classNumber>=1 && classNumber<=4),password:pick(row,"initial_password","初始密码") || studentNo.slice(-6)};
  });
  if (new Set(normalized.map((r) => r.studentNo)).size !== normalized.length) return reply.code(400).send({ code: "DUPLICATE_STUDENT_NO", message: "CSV中存在重复身份证号" });
  const hashes = await Promise.all(normalized.map((r) => bcrypt.hash(r.password, 10)));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(6754001)");
    for (let i = 0; i < normalized.length; i += 1) {
      const row = normalized[i]!;
      const enrolled=await client.query("SELECT 1 FROM users u JOIN enrollments e ON e.user_id=u.id WHERE u.student_no=$1 AND u.grade IS DISTINCT FROM $2::smallint",[row.studentNo,row.grade]);
      if(enrolled.rowCount)throw Object.assign(new Error(`第${i+2}行学生已报名，请先清理选课再调整年级`),{statusCode:409});
      const saved = await client.query(
        `INSERT INTO users(student_no,name,class_name,password_hash,must_change_password,role,enabled,grade)
         VALUES($1,$2,$3,$4,TRUE,'student',$5,$6)
         ON CONFLICT(student_no) DO UPDATE SET name=EXCLUDED.name,class_name=EXCLUDED.class_name,enabled=EXCLUDED.enabled,grade=EXCLUDED.grade,updated_at=NOW()
         WHERE users.role='student' AND users.deleted_at IS NULL RETURNING id`,
        [row.studentNo, row.name, row.className, hashes[i],row.enabled,row.grade]
      );
      if (!saved.rowCount) throw Object.assign(new Error(`第${i+2}行账号已保留，不能覆盖`), { statusCode:409 });
      await client.query("DELETE FROM sessions WHERE user_id=$1",[saved.rows[0].id]);
      await client.query("UPDATE enrollment_jobs SET status='CANCELLED',processed_at=clock_timestamp() WHERE user_id=$1 AND status='PENDING'",[saved.rows[0].id]);
    }
    await audit(client, admin.id, "IMPORT_STUDENTS", { count: normalized.length });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { count: normalized.length };
});

app.post("/api/admin/courses/import", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin || !(await ensureEditable(reply))) return;
  const rows = await uploadedCsv(request);
  const normalized = rows.map((row, index) => {
    const code = pick(row, "code", "课程编号");
    const name = pick(row, "name", "课程名称");
    const capacity = Number(pick(row, "capacity", "容量"));
    if (!code || !name || !Number.isInteger(capacity) || capacity <= 0) throw new Error(`第${index + 2}行课程编号、名称或容量无效`);
    const grade=({"高一":1,"高二":2,"1":1,"2":2} as Record<string,number>)[pick(row,"年级","grade")];
    if(!grade)throw Object.assign(new Error(`第${index+2}行课程需填写年级`),{statusCode:400});
    return { code, name, capacity, grade, teacher: pick(row, "teacher", "教师"), location: pick(row, "location", "地点"), description: pick(row, "description", "说明") };
  });
  if (new Set(normalized.map((r) => r.code)).size !== normalized.length) return reply.code(400).send({ code: "DUPLICATE_COURSE_CODE", message: "CSV中存在重复课程编号" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockImport(client);
    for (const row of normalized) {
      const existing=await client.query("SELECT grade FROM courses WHERE code=$1",[row.code]);
      if(existing.rows[0] && existing.rows[0].grade!==row.grade)throw Object.assign(new Error("已有课程不可通过导入修改年级"),{statusCode:409});
      const saved = await client.query(
        `INSERT INTO courses(code,name,teacher,location,description,capacity,grade)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,teacher=EXCLUDED.teacher,location=EXCLUDED.location,
           description=EXCLUDED.description,capacity=EXCLUDED.capacity,updated_at=NOW()
         RETURNING id`,
        [row.code, row.name, row.teacher, row.location, row.description, row.capacity,row.grade]
      );
      await client.query("DELETE FROM course_seats WHERE course_id=$1", [saved.rows[0].id]);
      await client.query("INSERT INTO course_seats(course_id,seat_no) SELECT $1,generate_series(1,$2)", [saved.rows[0].id, row.capacity]);
    }
    await audit(client, admin.id, "IMPORT_COURSES", { count: normalized.length });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { count: normalized.length };
});

app.put("/api/admin/period", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin) return;
  const body = z.object({
    state: z.enum(["DRAFT", "READY", "OPEN", "CLOSED"]),
    opensAt: z.string().datetime().nullable().optional(),
    closesAt: z.string().datetime().nullable().optional()
  }).parse(request.body);
  if(body.opensAt && body.closesAt && Date.parse(body.closesAt)<=Date.parse(body.opensAt))return reply.code(400).send({code:"INVALID_SCHEDULE",message:"截止时间必须晚于开启时间"});
  await managementTransaction(pool,async client=>{
    await client.query("UPDATE selection_period SET state=$1,opens_at=$2,closes_at=$3,updated_at=clock_timestamp() WHERE singleton=TRUE", [body.state, body.opensAt ?? null, body.closesAt ?? null]);
    await audit(client, admin.id, "UPDATE_PERIOD", body);
  });
  return { ok: true };
});

app.get("/api/admin/overview", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin) return;
  const result = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM users WHERE role='student' AND enabled AND deleted_at IS NULL) AS students,
    (SELECT COUNT(*)::int FROM users u WHERE role='student' AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM audit_logs a WHERE a.actor_id=u.id AND a.action='LOGIN')) AS logged_in,
    (SELECT COUNT(*)::int FROM courses WHERE enabled) AS courses,
    (SELECT COUNT(*)::int FROM enrollments e JOIN users u ON u.id=e.user_id WHERE u.deleted_at IS NULL) AS enrolled,
    (SELECT COALESCE(SUM(capacity),0)::int FROM courses WHERE enabled) AS capacity,
    (SELECT COUNT(*)::int FROM enrollment_jobs WHERE status='PENDING') AS pending`);
  return result.rows[0];
});

app.get("/api/admin/live", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin) return;
  const [courses, recent] = await Promise.all([
    pool.query(`SELECT c.id::text,c.code,c.name,c.capacity,c.enabled,c.grade,COUNT(s.user_id)::int AS enrolled,
      (c.capacity-COUNT(s.user_id))::int AS remaining FROM courses c
      LEFT JOIN course_seats s ON s.course_id=c.id GROUP BY c.id ORDER BY c.code`),
    pool.query(`SELECT j.id::text,u.student_no,u.name,u.grade,c.name AS course_name,j.status,j.received_at,j.client_sent_at_ms,j.margin_ms
      FROM enrollment_jobs j JOIN users u ON u.id=j.user_id JOIN courses c ON c.id=j.course_id
      ORDER BY j.received_at DESC,j.id DESC LIMIT 20`)
  ]);
  return { courses: courses.rows, recent: recent.rows };
});

registerManagement(app, pool, { requireAdmin, invalidateUser });
if(process.env.ENABLE_IDENTITY_RECOVERY==='true')registerPasswordRecovery(app,pool,{secure:config.COOKIE_SECURE,invalidateUser});
registerReset(app,pool,{requireAdmin,invalidateUser});

app.get("/api/admin/export/enrollments.csv", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin) return;
  const {grade}=z.object({grade:z.enum(['1','2']).optional()}).parse(request.query);
  const result = await pool.query(`SELECT u.student_no,u.name,u.class_name,u.grade,u.enabled,c.code,c.name course_name,c.teacher,c.location,e.client_sent_at_ms,e.created_at AS confirmed_at,
    COALESCE(j.received_at,e.created_at) AS registered_at
    FROM users u LEFT JOIN enrollments e ON e.user_id=u.id LEFT JOIN courses c ON c.id=e.course_id
    LEFT JOIN LATERAL (SELECT received_at FROM enrollment_jobs WHERE result_enrollment_id=e.id ORDER BY received_at LIMIT 1) j ON TRUE
    WHERE u.role='student' AND u.deleted_at IS NULL AND ($1::smallint IS NULL OR u.grade=$1) ORDER BY u.grade,u.class_name,u.student_no`,[grade??null]);
  await audit(pool, admin.id, "EXPORT_ENROLLMENTS");
  const rows = [["身份证号", "姓名", "年级", "班级", "选课权限", "状态", "课程编号", "课程名称", "教师", "地点", "客户端报名时间戳ms", "确认时间"], ...result.rows.map((r) => [r.student_no,r.name,r.grade===1?"高一":r.grade===2?"高二":"未设置",r.class_name,r.enabled?"允许报名":"限制选课",r.code?"已选":"未选",r.code,r.course_name,r.teacher,r.location,r.client_sent_at_ms,r.confirmed_at?.toISOString?.() ?? ""])];
  return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename=enrollments${grade?`-grade${grade}`:''}.csv`).send(csv(rows));
});

app.get("/api/admin/export/courses.csv", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin) return;
  const {grade}=z.object({grade:z.enum(['1','2']).optional()}).parse(request.query);
  const result = await pool.query(`SELECT c.code,c.name,c.teacher,c.location,c.capacity,c.grade,COUNT(s.user_id)::int enrolled_count,
    (c.capacity-COUNT(s.user_id))::int remaining FROM courses c LEFT JOIN course_seats s ON s.course_id=c.id WHERE ($1::smallint IS NULL OR c.grade=$1) GROUP BY c.id ORDER BY c.code`,[grade??null]);
  await audit(pool, admin.id, "EXPORT_COURSES");
  const rows = [["课程编号", "课程名称", "年级", "教师", "地点", "容量", "已选人数", "剩余名额"], ...result.rows.map((r) => [r.code, r.name,r.grade===1?"高一":r.grade===2?"高二":"历史课程", r.teacher, r.location, r.capacity, r.enrolled_count, r.remaining])];
  return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename=courses${grade?`-grade${grade}`:''}.csv`).send(csv(rows));
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error({code:(error as {code?:string}).code,statusCode:(error as {statusCode?:number}).statusCode},"request failed");
  if (error instanceof z.ZodError) return reply.code(400).send({ code: "INVALID_INPUT", message: "输入格式不正确", issues: error.issues });
  const httpError = error as Error & { statusCode?: number };
  if ((error as { code?: string }).code === "23505") return reply.code(409).send({ code:"DUPLICATE_RECORD", message:"账号或课程编号已存在；已删除账号仍保留" });
  if (httpError.statusCode && httpError.statusCode < 500) return reply.code(httpError.statusCode).send({ code: "BAD_REQUEST", message: httpError.message });
  return reply.code(500).send({ code: "INTERNAL_ERROR", message: "服务器内部错误" });
});

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
await app.register(staticFiles, { root: webRoot, wildcard: false });
app.setNotFoundHandler((request, reply) => {
  if (/^\/(api|assets|fonts)\//.test(request.url)) return reply.code(404).send({ code: "NOT_FOUND", message: "资源不存在" });
  return reply.sendFile("index.html");
});

await migrate();
registration.start();
await app.listen({ host: "0.0.0.0", port: config.PORT });

async function shutdown() {
  await registration.stop();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
