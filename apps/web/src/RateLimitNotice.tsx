import {useEffect,useState} from "react";
import {cooldownSeconds} from "./api";
export function RateLimitNotice(){
  const [warning,setWarning]=useState(false);
  useEffect(()=>{const show=()=>setWarning(true);window.addEventListener('selection:refresh-warning',show);return()=>window.removeEventListener('selection:refresh-warning',show);},[]);
  const [seconds,setSeconds]=useState(cooldownSeconds);
  useEffect(()=>{const update=()=>setSeconds(cooldownSeconds());window.addEventListener("selection:rate-limit",update);const timer=window.setInterval(update,250);return()=>{window.removeEventListener("selection:rate-limit",update);window.clearInterval(timer);};},[]);
  return seconds>0||warning ? <div className="refresh-fullscreen" role="alertdialog" aria-modal="true" aria-labelledby="refresh-warning"><section><h1 id="refresh-warning">{seconds>0?'访问已暂时暂停':'请勿频繁刷新，否则将导致您被服务器临时拉黑'}</h1>{seconds>0?<p>{seconds} 秒后恢复访问，已受理的报名不受影响。</p>:<button onClick={()=>setWarning(false)}>我已了解</button>}</section></div>:null;
}
