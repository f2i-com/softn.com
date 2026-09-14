const formats = new Map();
function formatter(zone) {
  if(typeof zone!=='string'||zone.length>80)throw new Error('Invalid time zone');
  if(formats.size>64)formats.clear();
  if (!formats.has(zone)) formats.set(zone, new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }));
  return formats.get(zone);
}
export function parseZoned(date, time, zone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Choose a valid date and time');
  const intended = date + 'T' + time;
  const approximate = Date.parse(intended + ':00Z');
  if (!Number.isFinite(approximate) || new Date(approximate).toISOString().slice(0,16) !== intended) throw new Error('Invalid calendar date or time');
  const fmt = formatter(zone), matches = [];
  // Match wall-clock fields and reject DST folds/gaps; minute-resolution offsets.
  for (let minutes = -14 * 60; minutes <= 14 * 60; minutes++) {
    const candidate = approximate + minutes * 60000;
    const p = Object.fromEntries(fmt.formatToParts(candidate).map(v => [v.type, v.value]));
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === intended) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'That local time occurs twice during daylight saving. Choose another time.' : 'That local time does not exist during daylight saving. Choose another time.');
  return Math.floor(matches[0] / 1000);
}
export function formatZoned(seconds, zone) {
  formatter(zone);
  return new Intl.DateTimeFormat('en-AU', { timeZone: zone, weekday: 'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' }).format(seconds*1000) + ' · ' + zone.split('/').at(-1).replaceAll('_',' ');
}
