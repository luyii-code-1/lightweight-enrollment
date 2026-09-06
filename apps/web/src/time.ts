// Date values are always presented in GMT+8, independent of the device timezone.
export function formatGmt8(value:string|number|null|undefined):string {
  if(value===null || value===undefined || value==='')return '—';
  const ms=typeof value==='number'?value:/^\d+$/.test(value)?Number(value):Date.parse(value);
  if(!Number.isFinite(ms))return '—';
  const shifted=new Date(ms+8*60*60*1000);
  if(!Number.isFinite(shifted.getTime()))return '—';
  return shifted.toISOString().slice(0,23).replace('T',' ')+' GMT+8';
}

export function gmt8InputToIso(value:string):string|null {
  if(!value)return null;
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value))throw new Error('请输入完整的 GMT+8 日期和时间');
  const date=new Date(value+'+08:00');
  if(!Number.isFinite(date.getTime()))throw new Error('日期或时间无效');
  return date.toISOString();
}

export function periodLabel(period:{state:string;accepting?:boolean;opens_at?:string|null;closes_at?:string|null;server_time?:string}):string {
  const now=period.server_time?Date.parse(period.server_time):Date.now();
  if(period.accepting)return '报名开放中';
  if(period.state==='OPEN' && period.closes_at && Date.parse(period.closes_at)<=now)return '已到截止时间';
  if(period.state==='OPEN' && period.opens_at && Date.parse(period.opens_at)>now)return `等待开启：${formatGmt8(period.opens_at)}`;
  return period.state==='CLOSED'?'报名已停止':'尚未开放';
}
