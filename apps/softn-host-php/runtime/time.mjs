const formats = new Map();
function formatter(zone) {
  if(typeof zone!=='string'||zone.length>80)throw new Error('Invalid time zone');
  if(formats.size>64)formats.clear();
  if (!formats.has(zone)) {
    let format;
    // A zone Intl does not know is this host's refusal to make, in its own
    // words, which are what a handler that catches it is told.
    try {
      format = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      });
    } catch { throw new Error('Invalid time zone'); }
    formats.set(zone, format);
  }
  return formats.get(zone);
}
export function parseZoned(date, time, zone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Choose a valid date and time');
  const intended = date + 'T' + time;
  const approximate = Date.parse(intended + ':00Z');
  if (!Number.isFinite(approximate) || new Date(approximate).toISOString().slice(0,16) !== intended) throw new Error('Invalid calendar date or time');
  const fmt = formatter(zone), matches = [];
  // Match wall-clock fields and reject DST folds/gaps; minute-resolution offsets.
  const search = (from, to) => {
    for (let minutes = from; minutes <= to; minutes++) {
      const candidate = approximate + minutes * 60000;
      const p = Object.fromEntries(fmt.formatToParts(candidate).map(v => [v.type, v.value]));
      if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === intended) matches.push(candidate);
    }
  };
  // Every zone's offset today is within 14 hours. A fixed offset may be up to
  // 23:59 (the Rust host reads "+15:00" too), and a zone's old local mean
  // time was past 14 hours in places, so with nothing nearer the rest of
  // the day either side is searched as well.
  search(-14 * 60, 14 * 60);
  if (!matches.length) { search(-24 * 60, -14 * 60 - 1); search(14 * 60 + 1, 24 * 60); }
  if (matches.length !== 1) throw new Error(matches.length ? 'That local time occurs twice during daylight saving. Choose another time.' : 'That local time does not exist during daylight saving. Choose another time.');
  return Math.floor(matches[0] / 1000);
}
// The words format() writes. They used to come from the en-AU locale of
// whichever Node ran this, and these are what it gave (June and July in full,
// "Sept"): held here, and in the Rust host's bridges/time.rs, so that the
// text is the same on both hosts and does not move when a locale library
// does. tests/time-parity.json is the list both are run against.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
/** "Thu, 1 Jan, 11:00 pm · Melbourne": the place is the last part of the zone as the caller spelt it. */
export function formatZoned(seconds, zone) {
  // The whole second a fractional timestamp falls in.
  const at = Math.floor(seconds) * 1000;
  const p = Object.fromEntries(formatter(zone).formatToParts(at).map(v => [v.type, v.value]));
  // The weekday of the date the zone's wall clock shows. A year before 1 is
  // printed without its era, which shows as a date nowhere near the instant.
  const wall = new Date(0);
  wall.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
  if (Math.abs(wall.getTime() - at) > 2 * 86400000) wall.setUTCFullYear(1 - Number(p.year), Number(p.month) - 1, Number(p.day));
  const hour = Number(p.hour);
  return `${WEEKDAYS[wall.getUTCDay()]}, ${Number(p.day)} ${MONTHS[Number(p.month) - 1]}, ${hour % 12 || 12}:${p.minute} ${hour < 12 ? 'am' : 'pm'} · ${zone.split('/').at(-1).replaceAll('_', ' ')}`;
}
