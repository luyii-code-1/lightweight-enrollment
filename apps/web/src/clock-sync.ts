export type ClockState={offsetMs:number;rttMs:number;checkedAt:number;monotonicAt:number};
export function clockOffset(start:number,end:number,server:number){return server-(start+end)/2;}
export function clockReady(clock:ClockState|null,now=Date.now(),monotonic=performance.now()){
 return !!clock && Math.abs(clock.offsetMs)<=400 && monotonic-clock.monotonicAt<300000 && Math.abs((now-clock.checkedAt)-(monotonic-clock.monotonicAt))<=20;
}
