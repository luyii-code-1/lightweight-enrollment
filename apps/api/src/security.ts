import type { FastifyInstance } from "fastify";

export function registerSecurity(app:FastifyInstance,allowedOrigins:Set<string>,secure:boolean) {
  app.addHook("onRequest",async(request,reply)=>{
    if(!request.url.split("?")[0]?.startsWith("/api/"))return;
    if(secure && request.protocol!=="https")return reply.code(426).send({code:"HTTPS_REQUIRED",message:"请通过学校 HTTPS 域名访问"});
    if(request.headers["sec-fetch-site"]==="cross-site")return reply.code(403).send({code:"INVALID_ORIGIN",message:"请求来源不受信任"});
    if(["POST","PUT","PATCH","DELETE"].includes(request.method)) {
      const origin=request.headers.origin;
      let refererOrigin:string|undefined;
      try{if(request.headers.referer)refererOrigin=new URL(request.headers.referer).origin;}catch{}
      // Browsers send Origin on mutations; Referer supports same-origin clients that omit it.
      const source=origin ?? refererOrigin;
      if(!source || !allowedOrigins.has(source))return reply.code(403).send({code:"INVALID_ORIGIN",message:"请求来源不受信任，请从学校域名重新登录"});
    }
  });
  app.addHook("onSend",async(request,reply,payload)=>{
    const pathname=request.url.split("?")[0] ?? "";
    if(pathname.startsWith("/api/") || reply.statusCode>=400)reply.header("Cache-Control","no-store");
    else if(/^(GET|HEAD)$/.test(request.method) && /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(pathname))reply.header("Cache-Control","public, max-age=31536000, immutable");
    else if(/^(GET|HEAD)$/.test(request.method) && /^\/fonts\/[^/]+\.woff2$/.test(pathname))reply.header("Cache-Control","public, max-age=86400");
    else reply.header("Cache-Control","no-cache");
    reply.header("X-Content-Type-Options","nosniff");
    reply.header("X-Frame-Options","DENY");
    reply.header("Referrer-Policy","same-origin");
    reply.header("Permissions-Policy","camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if(secure && request.protocol==="https")reply.header("Strict-Transport-Security","max-age=31536000");
    return payload;
  });
}
