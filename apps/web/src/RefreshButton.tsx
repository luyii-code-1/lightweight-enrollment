import {useEffect,useState} from 'react';
import {REFRESH_EVENT,refreshSeconds,requestRefresh} from './manual-refresh';
export function RefreshButton({disabled=false}:{disabled?:boolean}){
  const [seconds,setSeconds]=useState(refreshSeconds);
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const update=()=>{clearTimeout(timer);const value=refreshSeconds();setSeconds(value);if(value>0)timer=setTimeout(update,250);};
    window.addEventListener(REFRESH_EVENT,update);update();
    return()=>{clearTimeout(timer);window.removeEventListener(REFRESH_EVENT,update);};
  },[]);
  return <button type="button" className="text-button" disabled={disabled || seconds>0} onClick={requestRefresh}>{seconds>0?`刷新（${seconds}s）`:'刷新'}</button>;
}
