export function watermarkImage(userId:string){
  const safeId=userId.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="170"><text x="130" y="85" text-anchor="middle" transform="rotate(-24 130 85)" font-family="sans-serif" font-size="15" fill="#173a58" fill-opacity="0.15">用户 ID：${safeId}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
