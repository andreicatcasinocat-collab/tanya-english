// Время и даты. Всё хранится как локальное время преподавателя: 'YYYY-MM-DD' и 'HH:MM'.
const pad = (n) => String(n).padStart(2, '0');
export const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const asUtc = (date, time = '00:00') => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi);
};
export function addDays(date, days) {
  const d = new Date(asUtc(date) + days * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export const isoWeekday = (date) => ((new Date(asUtc(date)).getUTCDay() + 6) % 7) + 1;
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isTime = (s) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);

export function makeTime(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const now = () => {
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  };
  return {
    now,
    minutesUntil(date, time) {
      const n = now();
      return (asUtc(date, time) - asUtc(n.date, n.time)) / 60000;
    },
  };
}

export function fmtDate(date, opts = { weekday: 'short', day: 'numeric', month: 'long' }) {
  return new Intl.DateTimeFormat('ru-RU', { ...opts, timeZone: 'UTC' }).format(new Date(asUtc(date)));
}

// ---------- часовые пояса ----------
const partsCache = new Map();
function zParts(tz, ms) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    partsCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
/** Смещение пояса от UTC в минутах в момент ms. */
export function tzOffset(tz, ms) {
  const z = zParts(tz, ms);
  return Math.round((asUtc(z.date, z.time) - Math.floor(ms / 60000) * 60000) / 60000);
}
/** Локальное время в поясе tz → момент UTC (ms). */
export function zonedToUtc(date, time, tz) {
  const guess = asUtc(date, time);
  let ms = guess - tzOffset(tz, guess) * 60000;
  const off2 = tzOffset(tz, ms);
  ms = guess - off2 * 60000;
  return ms;
}
export const utcToZoned = (ms, tz) => zParts(tz, ms);
/** Перевод даты/времени из пояса from в пояс to. */
export function convert(date, time, from, to) {
  if (from === to) return { date, time };
  return zParts(to, zonedToUtc(date, time, from));
}
export function isValidTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return typeof tz === 'string' && tz.length < 64; } catch { return false; }
}
export const TIMEZONES = [
  ['Europe/Kaliningrad', 'Калининград'], ['Europe/Moscow', 'Москва'], ['Europe/Samara', 'Самара'],
  ['Asia/Yekaterinburg', 'Екатеринбург'], ['Asia/Omsk', 'Омск'], ['Asia/Novosibirsk', 'Новосибирск'],
  ['Asia/Krasnoyarsk', 'Красноярск'], ['Asia/Irkutsk', 'Иркутск'], ['Asia/Vladivostok', 'Владивосток'],
  ['Europe/Kyiv', 'Киев'], ['Europe/Minsk', 'Минск'], ['Asia/Almaty', 'Алматы'], ['Asia/Tbilisi', 'Тбилиси'],
  ['Asia/Dubai', 'Дубай'], ['Asia/Bangkok', 'Бангкок / Пхукет'], ['Asia/Ho_Chi_Minh', 'Вьетнам'],
  ['Asia/Makassar', 'Бали'], ['Europe/Berlin', 'Берлин / Европа'], ['Europe/London', 'Лондон'], ['America/New_York', 'Нью-Йорк'],
];
export function tzLabel(tz, ms = Date.now()) {
  let name = TIMEZONES.find(([z]) => z === tz)?.[1];
  if (!name) {
    try { name = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value; } catch { /* ниже */ }
    name ||= tz.split('/').pop().replace(/_/g, ' ');
  }
  const off = tzOffset(tz, ms);
  const h = Math.trunc(Math.abs(off) / 60), m = Math.abs(off) % 60;
  return `${name} (UTC${off >= 0 ? '+' : '−'}${h}${m ? ':' + String(m).padStart(2, '0') : ''})`;
}
export const tzShort = (tz) => (tz === 'Europe/Moscow' ? 'МСК' : tzLabel(tz).replace(/^.*\((.*)\)$/, '$1'));
