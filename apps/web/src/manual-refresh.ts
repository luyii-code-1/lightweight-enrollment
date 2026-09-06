export const REFRESH_EVENT='selection:manual-refresh';
let nextRefreshAt=0;
export function refreshSeconds(){return Math.max(0,Math.ceil((nextRefreshAt-Date.now())/1000));}
export function requestRefresh(){
  if(refreshSeconds()>0)return false;
  nextRefreshAt=Date.now()+10000;
  window.dispatchEvent(new Event(REFRESH_EVENT));
  return true;
}
// Load once, then only on an explicit page refresh. Do not overlap requests.
export function subscribeRefresh(work:()=>Promise<unknown>,onError?:(error:unknown)=>void,immediate=true){
  let stopped=false, running=false;
  const run=async()=>{
    if(stopped || running)return;
    running=true;
    try{await work();}catch(error){if(!stopped)onError?.(error);}
    finally{running=false;}
  };
  window.addEventListener(REFRESH_EVENT,run);
  if(immediate)void run();
  return ()=>{stopped=true;window.removeEventListener(REFRESH_EVENT,run);};
}
