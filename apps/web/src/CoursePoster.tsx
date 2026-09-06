import {useEffect,useRef,useState} from 'react';
import {coursePosterUrl} from './posters';
import {Watermark} from './Watermark';

function PosterDialog({name,url,onClose}:{name:string;url:string;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  useEffect(()=>{
    const element=dialog.current!;
    element.showModal();
    return ()=>element.close();
  },[]);
  return <dialog ref={dialog} className="poster-dialog" aria-labelledby="poster-title" onClose={onClose} onClick={event=>{
    if(event.target!==event.currentTarget)return;
    const bounds=event.currentTarget.getBoundingClientRect();
    if(event.clientX<bounds.left || event.clientX>bounds.right || event.clientY<bounds.top || event.clientY>bounds.bottom)event.currentTarget.close();
  }}>
    <Watermark/>
    <div className="poster-heading"><h2 id="poster-title">{name}</h2><button type="button" className="secondary" autoFocus onClick={()=>dialog.current?.close()}>关闭</button></div>
    <div className="poster-content" aria-busy={status==='loading'}>
      {status==='loading' && <div className="poster-loading" role="status"><span className="poster-spinner" aria-hidden="true"/><span>正在加载海报…</span></div>}
      {status==='error'?<p role="alert">海报暂时无法加载，请稍后重试。</p>:<img src={url} alt={`${name}社团海报`} decoding="async" referrerPolicy="no-referrer" onLoad={()=>setStatus('ready')} onError={()=>setStatus('error')}/>}
    </div>
  </dialog>;
}

export function CoursePoster({name}:{name:string}){
  const [open,setOpen]=useState(false);
  const url=coursePosterUrl(name);
  if(!url)return null;
  return <><button type="button" className="secondary poster-trigger" aria-haspopup="dialog" aria-label={`预览${name}海报`} onClick={()=>setOpen(true)}>预览</button>{open && <PosterDialog key={url} name={name} url={url} onClose={()=>setOpen(false)}/>}</>;
}
