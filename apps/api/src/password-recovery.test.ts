import {describe,it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type {Pool} from 'pg';
import {registerPasswordRecovery} from './password-recovery.js';
const body={name:'测试学生',identity:'980000200001010001',grade:1,className:'5',newPassword:'NewPassword2026',confirmation:'NewPassword2026'};
function fixture(found=false){
 let consumed=false;const statements:string[]=[];
 const query=vi.fn(async(sql:string)=>{statements.push(sql);if(sql.startsWith('SELECT u.id'))return {rows:found&&!consumed?[{id:'12'}]:[],rowCount:found&&!consumed?1:0};if(sql.startsWith('DELETE FROM password_recovery_codes'))consumed=true;return {rows:[],rowCount:1};});
 const client={query,release:vi.fn()},pool={query,connect:async()=>client} as unknown as Pool;
 const invalidateUser=vi.fn(),app=Fastify();app.register(cookie);registerPasswordRecovery(app,pool,{secure:true,invalidateUser});
 return {app,statements,invalidateUser};
}
describe('password recovery',()=>{
 it('requires admin for issuance',async()=>{const {app}=fixture();try{expect((await app.inject({method:'POST',url:'/api/admin/students/12/recovery-code'})).statusCode).toBe(404);}finally{await app.close();}});
 it('rejects mismatched identity/code with no writes, throttles repeated attempts',async()=>{const {app,statements}=fixture();try{for(let i=0;i<8;i++)expect((await app.inject({method:'POST',url:'/api/auth/forgot-password',payload:body})).statusCode).toBe(400);expect((await app.inject({method:'POST',url:'/api/auth/forgot-password',payload:body})).statusCode).toBe(429);expect(statements.every(s=>s.startsWith('SELECT'))).toBe(true);}finally{await app.close();}});
 it('resets password and creates authenticated session',async()=>{const {app,statements,invalidateUser}=fixture(true);try{const response=await app.inject({method:'POST',url:'/api/auth/forgot-password',payload:body});expect(response.statusCode).toBe(200);expect(response.headers['set-cookie']).toContain('HttpOnly');expect(statements).toContain('DELETE FROM sessions WHERE user_id=$1');expect(statements).toContain('COMMIT');expect(invalidateUser).toHaveBeenCalledWith('12');expect(statements.some(s=>/UPDATE.*enabled|DELETE FROM enrollments/.test(s))).toBe(false);expect(statements.some(s=>s.includes("'LOGIN'"))).toBe(true);}finally{await app.close();}});
});
