import {describe,it,expect} from 'vitest';
import {SessionRateLimiter,clientKey} from './session-rate-limit.js';
describe('Session + IP + UA page refresh limit',()=>{
 it('warns on sixth refresh, blocks on next sixth, and expires after 10 seconds',()=>{
  let now=0;const l=new SessionRateLimiter(()=>now);l.register('a','u',100000);
  for(let i=0;i<5;i++)expect(l.check('a')).toEqual({warning:false,retryAfter:0});
  expect(l.check('a')?.warning).toBe(true);
  for(let i=0;i<100;i++)expect(l.check('a',false)?.retryAfter).toBe(0);
  for(let i=0;i<5;i++)l.check('a');
  expect(l.check('a')?.retryAfter).toBe(10);
  now=9999;expect(l.check('a',false)?.retryAfter).toBe(1);
  now=10000;expect(l.check('a',false)?.retryAfter).toBe(0);
  for(let i=0;i<5;i++)l.check('a');expect(l.check('a')?.warning).toBe(true);
 });
 it('uses a sliding five-second window and no API count',()=>{
  let now=0;const l=new SessionRateLimiter(()=>now);l.register('a','u',100000);
  for(let i=0;i<20;i++){expect(l.check('a')?.warning).toBe(false);now+=1000;}
 });
 it('separates session/IP/UA and removes revoked/expired identities',()=>{
  const a=clientKey('s','ip','ua');expect(a).not.toBe(clientKey('s2','ip','ua'));expect(a).not.toBe(clientKey('s','ip2','ua'));expect(a).not.toBe(clientKey('s','ip','ua2'));
  let now=0;const l=new SessionRateLimiter(()=>now);expect(l.check(a)).toBeNull();l.register(a,'u',1000);l.revokeUser('u');expect(l.check(a)).toBeNull();l.register(a,'u',1000);now=1000;expect(l.check(a)).toBeNull();
 });
});
