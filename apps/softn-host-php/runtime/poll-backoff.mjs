// How long the live bridge waits before it polls a route again; see websocket.mjs.
// Dependency-free so it can be tested without the packaged ws vendor tree.
//
// The bridge polled every interval whatever came back. A host answering 429 (every
// poll comes from the bridge's one address, so its clients share one allowance) or
// 5xx was asked again just as often by every connection: the allowance never came
// back, and a host that was struggling was not let be.

// The longest a connection waits between polls, however many have failed and
// whatever `Retry-After` says: a host that is well again is found within this.
export const MAX_BACKOFF_MS=5*60*1000;

// `Retry-After` as milliseconds from `now`: a count of seconds, or an HTTP date
// (0 for one that has passed). Null for anything else, and for no header.
export function retryAfterMs(value,now=Date.now()) {
  if(typeof value!=='string')return null;
  const text=value.trim();
  if(/^\d{1,9}$/.test(text))return Number(text)*1000;
  if(!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text))return null;
  const at=Date.parse(text);
  return Number.isFinite(at)?Math.max(0,at-now):null;
}

// The wait before the next poll. `failures` is how many polls in a row have not
// brought an answer (a 200 or a 304): none, and it is the interval; otherwise the
// interval doubled for each, and no less than the host's `Retry-After` (in
// milliseconds, or null), both up to `maxBackoffMs`. An answer sets `failures`
// back to 0, so one good poll is followed at the interval again.
export function pollDelayMs({intervalMs,failures,retryAfter=null,maxBackoffMs=MAX_BACKOFF_MS}) {
  if(!(failures>0))return intervalMs;
  const longest=Math.max(intervalMs,maxBackoffMs);
  const doubled=Math.min(longest,intervalMs*2**Math.min(failures,30));
  return typeof retryAfter==='number'&&retryAfter>doubled?Math.min(longest,retryAfter):doubled;
}
