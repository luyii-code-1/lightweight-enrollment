export const POSTER_ORIGIN='';
export const POSTER_DIRECTORY='posters';

export function coursePosterUrl(courseName:string):string|null {
  const name=courseName.trim();
  if(!name)return null;
  const extension='jpg';
  return `${POSTER_ORIGIN}/${encodeURIComponent(POSTER_DIRECTORY)}/${encodeURIComponent(name)}.${extension}`;
}
