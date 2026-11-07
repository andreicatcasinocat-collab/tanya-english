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
