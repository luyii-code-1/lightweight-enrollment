import {createHash} from 'node:crypto';
type Entry={userId:string;expiresAt:number;times:number[];warned:boolean;blockedUntil:number};
export type RateDecision={warning:boolean;retryAfter:number};
export const refreshWarning='请勿频繁刷新，否则将导致您被服务器临时拉黑';
export function clientKey(sessionHash:string,ip:string,ua:string){return createHash('sha256').update(JSON.stringify([sessionHash,ip,ua])).digest('hex');}
export class SessionRateLimiter{
 private entries=new Map<string,Entry>();private nextSweep=0;
 constructor(private now=()=>Date.now(),private limit=5,private windowMs=5000,private penaltyMs=10000){}
 register(key:string,userId:string,expiresAt:number){
  const now=this.now();if(now>=this.nextSweep){for(const [k,e] of this.entries)if(e.expiresAt<=now)this.entries.delete(k);this.nextSweep=now+30000;}
  if(!this.entries.has(key)){if(this.entries.size>=10000)this.entries.delete(this.entries.keys().next().value!);this.entries.set(key,{userId,expiresAt,times:[],warned:false,blockedUntil:0});}
 }
 forget(key:string){this.entries.delete(key);}
 revokeUser(id:string){for(const [k,e] of this.entries)if(e.userId===id)this.entries.delete(k);}
 check(key:string,countRefresh=true):RateDecision|null{
  const now=this.now(),e=this.entries.get(key);if(!e)return null;
  if(e.expiresAt<=now){this.entries.delete(key);return null;}
  if(e.blockedUntil>now)return {warning:false,retryAfter:Math.ceil((e.blockedUntil-now)/1000)};
  if(e.blockedUntil){e.blockedUntil=0;e.times=[];e.warned=false;}
  if(!countRefresh)return {warning:false,retryAfter:0};
  e.times=e.times.filter(t=>now-t<this.windowMs);e.times.push(now);
  if(e.times.length<=this.limit)return {warning:false,retryAfter:0};
  e.times=[];
  if(!e.warned){e.warned=true;return {warning:true,retryAfter:0};}
  e.blockedUntil=now+this.penaltyMs;return {warning:false,retryAfter:this.penaltyMs/1000};
 }
}
