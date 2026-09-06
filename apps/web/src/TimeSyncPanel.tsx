import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {formatGmt8} from './time';
import {clockOffset,clockReady,type ClockState} from './clock-sync';

export function TimeSyncPanel({opensAt,closesAt,onChange}:{opensAt?:string|null;closesAt?:string|null;onChange:(state:ClockState|null)=>void}){
 const [clock,setClock]=useState<ClockState|null>(null),[error,setError]=useState(''),[checking,setChecking]=useState(false),[tick,setTick]=useState(Date.now());
 const controller=useRef<AbortController|null>(null);
 async function calibrate(){
  controller.current?.abort();const current=new AbortController();controller.current=current;
  setChecking(true);setError('');onChange(null);
  try{
   const samples=[];
   for(let i=0;i<3;i++){
    const start=Date.now(),mono=performance.now();
    const value=await api<{serverTimeMs:number}>('/api/time',{cache:'no-store',signal:current.signal});
    const end=Date.now(),elapsed=performance.now()-mono;
    if(Math.abs(end-start-elapsed)>20)throw Error('设备时间发生变化，请重新校时');
    samples.push({offsetMs:clockOffset(start,end,value.serverTimeMs),rttMs:elapsed});
   }
   if(current.signal.aborted)return;
   const best=samples.sort((a,b)=>a.rttMs-b.rttMs)[0];
   const next={...best,checkedAt:Date.now(),monotonicAt:performance.now()};setClock(next);onChange(next);
  }catch(cause){if(!current.signal.aborted){setError((cause as Error).message);setClock(null);onChange(null);}}
  finally{if(!current.signal.aborted)setChecking(false);}
 }
 useEffect(()=>{void calibrate();const timer=window.setInterval(()=>setTick(Date.now()),1000);return()=>{window.clearInterval(timer);controller.current?.abort();};},[]);
 const valid=clockReady(clock),serverNow=clock?clock.checkedAt+clock.offsetMs+(performance.now()-clock.monotonicAt):null;
 const open=opensAt?Date.parse(opensAt):NaN,close=closesAt?Date.parse(closesAt):NaN;
 const progress=serverNow!==null&&Number.isFinite(open)&&Number.isFinite(close)&&close>open?Math.max(0,Math.min(100,(serverNow-open)/(close-open)*100)):null;
 const countdown=serverNow===null?'正在校时':serverNow<open?`距开放 ${duration(open-serverNow)}`:serverNow<close?`距截止 ${duration(close-serverNow)}`:Number.isFinite(close)?'报名时段已结束':'等待报名安排';
 return <section className={`time-sync ${clock&&!valid?'time-sync-warning':''}`} aria-label="报名时间与设备校时"><div><strong>服务器时间</strong><span>{formatGmt8(serverNow)}</span><small>{countdown}</small></div><div className="clock-difference"><span>设备时间：{formatGmt8(tick)}</span><strong>估算时间差：{clock?`${Math.round(clock.offsetMs)>=0?'+':''}${Math.round(clock.offsetMs)} ms`:'—'}</strong><small>{clock?`服务器减设备 · 往返 ${Math.round(clock.rttMs)} ms · 网络估算误差约 ±${Math.ceil(clock.rttMs/2)} ms`:'服务器 → 设备'}</small></div><button className="secondary" type="button" disabled={checking} onClick={calibrate}>{checking?'正在校时…':'重新校时'}</button>{progress!==null&&<progress max="100" value={progress} aria-label="报名时段进度"/>}{clock&&!valid&&<p role="alert">{Math.abs(clock.offsetMs)>400?'设备时间偏差超过 400 ms，请在系统设置中开启自动设置日期和时间，建议校准后重新检测，不影响报名。':'校时已过期或设备时间发生变化，建议重新校时，不影响报名。'}</p>}{error&&<p role="alert">校时失败：{error}，请重试。</p>}<small className="clock-source">时间源：服务器系统时钟 · 校时有效期 5 分钟</small></section>;
}
function duration(ms:number){const total=Math.max(0,Math.ceil(ms/1000)),hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60),seconds=total%60;return hours?`${hours} 小时 ${minutes} 分 ${seconds} 秒`:minutes?`${minutes} 分 ${seconds} 秒`:`${seconds} 秒`;}
