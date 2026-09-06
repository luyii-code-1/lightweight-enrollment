import { describe,it,expect } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { registerSecurity } from "./security.js";

const origin="https://enrollment.example.org";
async function instance(){
  const app=Fastify({trustProxy:["172.20.0.1"]});
  await app.register(cookie);
  registerSecurity(app,new Set([origin]),true);
  await app.register(cors,{credentials:true,origin:(value,callback)=>callback(null,!value || value===origin)});
  app.post("/api/auth/login",async(_req,reply)=>{reply.setCookie("selection_session","fixture",{secure:true,httpOnly:true,sameSite:"lax",path:"/",maxAge:7200});return {ok:true};});
  app.get("/api/me",async(_req,reply)=>reply.code(401).send({code:"UNAUTHENTICATED"}));
  app.get("/",async()=>"fixture");
  app.get("/assets/index-Abc12345.js",async()=>"fixture");
  app.get("/fonts/example.woff2",async()=>"fixture");
  app.get("/assets/missing-Abc12345.js",async(_request,reply)=>reply.code(404).send("missing"));
  return app;
}
const trusted={remoteAddress:"172.20.0.1",headers:{origin,"x-forwarded-proto":"https"}};
describe("HTTPS security policy",()=>{
  it("caches versioned static files but revalidates HTML and never caches errors",async()=>{
    const app=await instance();try{
      expect((await app.inject({...trusted,url:"/assets/index-Abc12345.js?v=1"})).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect((await app.inject({...trusted,url:"/fonts/example.woff2"})).headers["cache-control"]).toBe("public, max-age=86400");
      expect((await app.inject({...trusted,url:"/"})).headers["cache-control"]).toBe("no-cache");
      expect((await app.inject({...trusted,url:"/assets/missing-Abc12345.js"})).headers["cache-control"]).toBe("no-store");
    }finally{await app.close();}
  });
  it("allows the HTTPS origin, sets secure host-only cookie and safety headers",async()=>{
    const app=await instance();try{
      const response=await app.inject({...trusted,method:"POST",url:"/api/auth/login"});
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["set-cookie"]).toContain("Secure");expect(response.headers["set-cookie"]).toContain("HttpOnly");expect(response.headers["set-cookie"]).toContain("SameSite=Lax");expect(response.headers["set-cookie"]).toContain("Max-Age=7200");expect(response.headers["set-cookie"]).not.toContain("Domain=");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("img-src 'self' data:;");
      expect(response.headers["content-security-policy"]).toContain("connect-src 'self';");
      expect((await app.inject({...trusted,url:"/api/me"})).headers["cache-control"]).toBe("no-store");
      expect((await app.inject({...trusted,url:"/"})).headers["strict-transport-security"]).toBe("max-age=31536000");
    }finally{await app.close();}
  });
  it("rejects old, null, missing, sibling and cross-site mutation origins",async()=>{
    const app=await instance();try{
      for(const value of ["http://192.0.2.1:6754","null","https://other.example.org",undefined]){
        const headers:Record<string,string>={"x-forwarded-proto":"https"};if(value)headers.origin=value;
        const response=await app.inject({remoteAddress:trusted.remoteAddress,method:"POST",url:"/api/auth/login",headers});expect(response.statusCode).toBe(403);
      }
      expect((await app.inject({...trusted,method:"POST",url:"/api/auth/login",headers:{...trusted.headers,"sec-fetch-site":"cross-site"}})).statusCode).toBe(403);
      expect((await app.inject({...trusted,method:"POST",url:"/api/auth/login",headers:{"x-forwarded-proto":"https",referer:origin+"/"}})).statusCode).toBe(200);
      const options=await app.inject({...trusted,method:"OPTIONS",url:"/api/auth/login",headers:{...trusted.headers,"access-control-request-method":"POST"}});expect(options.statusCode).toBe(204);
    }finally{await app.close();}
  });
  it("rejects plaintext and forwarded-proto spoofing from an untrusted peer",async()=>{
    const app=await instance();try{
      expect((await app.inject({url:"/api/me",remoteAddress:"172.20.0.1"})).statusCode).toBe(426);
      expect((await app.inject({...trusted,url:"/api/me",remoteAddress:"192.0.2.10"})).statusCode).toBe(426);
      expect((await app.inject({...trusted,url:"/api/me"})).statusCode).toBe(401);
    }finally{await app.close();}
  });
});
