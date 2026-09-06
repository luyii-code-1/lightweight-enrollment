const cooldownKey="selection:cooldown-until";
let blockedUntil=0;
try {const saved=Number(sessionStorage.getItem(cooldownKey));if(saved>Date.now() && saved<=Date.now()+11000)blockedUntil=saved;}catch{}
export function cooldownSeconds(){return Math.max(0,Math.ceil((blockedUntil-Date.now())/1000));}
function rateError(seconds:number){return Object.assign(new Error(`请求过于频繁，请等待 ${seconds} 秒后重试`),{code:"SESSION_RATE_LIMITED",status:429,retryAfter:seconds});}
function clearCooldown(){blockedUntil=0;try{sessionStorage.removeItem(cooldownKey);}catch{}window.dispatchEvent(new Event("selection:rate-limit"));}
export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const auth=url==="/api/auth/login"||url==="/api/auth/logout"||url==="/api/auth/forgot-password";
  if(!auth && cooldownSeconds()>0)throw rateError(cooldownSeconds());
  const response = await fetch(url, {
    credentials: "include", ...options,
    headers: { ...(options.body != null && !(options.body instanceof FormData) ? { "Content-Type":"application/json" } : {}), ...options.headers }
  });
  const result = (response.headers.get("content-type") ?? "").includes("json") ? await response.json() : await response.text();
  if(response.headers.get("X-Session-Rate-Warning")==="1")window.dispatchEvent(new Event("selection:refresh-warning"));
  if(response.status===429 && result.code==="SESSION_RATE_LIMITED"){
    const seconds=Math.max(1,Math.min(10,Number(response.headers.get("Retry-After"))||10));
    blockedUntil=Date.now()+seconds*1000;
    try{sessionStorage.setItem(cooldownKey,String(blockedUntil));}catch{}
    window.dispatchEvent(new Event("selection:rate-limit"));
    throw rateError(seconds);
  }
  if (!response.ok) {
    if(response.status===401 && url!=="/api/auth/login") window.dispatchEvent(new Event("selection:unauthenticated"));
    throw Object.assign(new Error(result.message ?? "请求失败"), { code:result.code,status:response.status });
  }
  if(auth)clearCooldown();
  return result as T;
}
