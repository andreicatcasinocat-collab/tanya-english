'use strict';
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
if (tg?.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const qs = new URLSearchParams(location.search);
const devAs = qs.get('as');
// Адрес API: по умолчанию тот же сайт. Для копии на GitHub Pages бот передаёт ?api= (только доверенные адреса).
const API_BASE = (() => {
  const a = qs.get('api');
  if (a && /^https:\/\/([a-z0-9-]+\.trycloudflare\.com|[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)$/.test(a)) return a;
  return location.origin;
})();

// Скрывать клавиатуру при нажатии вне поля ввода (в Telegram на телефоне она иначе не прячется)
const isField = (el) => el && el.closest && el.closest('input, textarea, select, [contenteditable]');
document.addEventListener('pointerdown', (e) => {
  const a = document.activeElement;
  if (isField(a) && !isField(e.target)) a.blur();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('input:not([type=checkbox])')) e.target.blur();
});

// ---------- API ----------
async function api(path, body) {
  const url = new URL(path, API_BASE);
  if (devAs) url.searchParams.set('as', devAs);
  let res;
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-init-data': tg?.initData || '', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Сервер недоступен. Закройте сайт и откройте снова через кнопку «Сайт» в боте.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка');
  return data;
}
/** Картинка чека: загружаем с авторизацией и показываем как blob. */
async function receiptImage(id) {
  const url = new URL('/api/admin/receipt-file', API_BASE);
  url.searchParams.set('id', id);
  if (devAs) url.searchParams.set('as', devAs);
  const res = await fetch(url, { headers: { 'x-init-data': tg?.initData || '' } });
  if (!res.ok) throw new Error('Не удалось загрузить чек');
  return { url: URL.createObjectURL(await res.blob()), type: res.headers.get('content-type') || '' };
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (s, n) => iso(new Date(parse(s).getTime() + n * 864e5));
const fmt = (s, o = { weekday: 'short', day: 'numeric', month: 'long' }) => new Intl.DateTimeFormat('ru-RU', { ...o, timeZone: 'UTC' }).format(parse(s));
const monthTitle = (s) => fmt(s, { month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
const monthBounds = (ym) => { const [y, m] = ym.split('-').map(Number); return [`${ym}-01`, iso(new Date(Date.UTC(y, m, 0)))]; };
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const STATUS = {
  pending: 'ждёт подтверждения', confirmed: 'подтверждён', cancelled: 'отменён', late_cancel: 'поздняя отмена',
  rejected: 'отклонён', done: 'проведён', no_show: 'неявка',
};
const ACTIONS = {
  'booking.create': 'Новая бронь', 'booking.confirmed': 'Подтверждение', 'booking.rejected': 'Отклонение заявки',
  'booking.cancelled': 'Отмена', 'booking.late_cancel': 'Поздняя отмена', 'booking.done': 'Урок проведён',
  'booking.no_show': 'Неявка', 'booking.reschedule': 'Перенос', 'booking.notes': 'Тема / ДЗ',
  'payment.add': 'Оплата', 'payment.reminder': 'Напоминание об оплате', 'receipt.add': 'Чек от ученика', 'receipt.rejected': 'Чек отклонён',
  'user.start': 'Открыл бота', 'user.registered': 'Регистрация', 'user.update': 'Изменение ученика', 'user.manual_add': 'Добавлен вручную',
  'user.linked': 'Подключил Telegram', 'settings.update': 'Настройки', 'day.override': 'Изменение дня', 'day.override_clear': 'Сброс дня',
  'block.add': 'Блокировка времени', 'block.remove': 'Снятие блокировки', 'broadcast': 'Рассылка',
  'message.sent': 'Сообщение ученику', 'export': 'Экспорт', 'reminder.rem24': 'Напоминание за сутки',
  'reminder.rem2': 'Напоминание за 2 часа', 'reminder.rem15': 'Напоминание за 15 минут', 'system.start': 'Запуск системы',
  'system.setup': 'Настройка сервера', 'security.flood': 'Защита: флуд', 'security.admin_code_fail': 'Защита: неверный код',
  'security.admin_added': 'Новый преподаватель',
};
const loadLevel = (d) => (d.off ? -1 : d.load === 0 ? 0 : d.load < 0.34 ? 1 : d.load < 0.67 ? 2 : d.load < 1 ? 3 : 4);
const initials = (n) => (n || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const haptic = (t = 'light') => tg?.HapticFeedback?.impactOccurred(t);
const money = (n) => `${Number(n || 0).toLocaleString('ru-RU')} ${S.cur}`;
const lessonsWord = (n) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? 'уроков' : b === 1 ? 'урок' : b >= 2 && b <= 4 ? 'урока' : 'уроков'; };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}
function openSheet(html, onMount) {
  const sh = $('#sheet');
  sh.innerHTML = html;
  sh.scrollTop = 0;
  document.body.classList.add('sheet-open');
  onMount?.(sh);
}
function closeSheet() { document.activeElement?.blur?.(); document.body.classList.remove('sheet-open'); }
$('#backdrop').onclick = closeSheet;
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); haptic('medium'); return r; } catch (e) { toast('⚠️ ' + e.message); throw e; }
}
function confirmBox(text) {
  return new Promise((res) => (tg?.showConfirm ? tg.showConfirm(text, res) : res(confirm(text))));
}

// ---------- state ----------
const S = { me: null, tab: null, month: null, selDate: null, cur: '₽', monthCache: new Map(), statRange: null };

async function loadMonth(ym, force = false) {
  if (!force && S.monthCache.has(ym)) return S.monthCache.get(ym);
  const [from, to] = monthBounds(ym);
  const p = api(`/api/month?from=${from}&to=${to}`).then((days) => Object.fromEntries(days.map((d) => [d.date, d])));
  S.monthCache.set(ym, p);
  p.catch(() => S.monthCache.delete(ym));
  return p;
}
const nextYm = (ym, k) => { const [y, m] = ym.split('-').map(Number); return iso(new Date(Date.UTC(y, m - 1 + k, 1))).slice(0, 7); };

// ---------- month calendar ----------
async function monthCalendar(container, { onPick, studentMode }) {
  const ym = S.month;
  const days = await loadMonth(ym);
  loadMonth(nextYm(ym, 1)).catch(() => {}); // заранее грузим следующий месяц
  const [first] = monthBounds(ym);
  const lead = (parse(first).getUTCDay() + 6) % 7;
  const today = S.me.today.date;
  const maxDate = addDays(today, Number(S.me.settings.days_ahead));
  const open = (d) => d.free && d.date >= today && d.date <= maxDate;
  container.innerHTML = `
    <div class="cal-head">
      <button class="icon-btn" data-m="-1" aria-label="Предыдущий месяц">‹</button>
      <h2>${monthTitle(first)}</h2>
      <button class="icon-btn" data-m="1" aria-label="Следующий месяц">›</button>
    </div>
    <div class="cal">
      ${WD.map((w) => `<div class="wd">${w}</div>`).join('')}
      ${'<div class="day empty"></div>'.repeat(lead)}
      ${Object.values(days).map((d) => {
        const past = d.date < today;
        const meta = d.off ? 'вых' : studentMode ? (open(d) ? `${d.free} св.` : '') : d.lessons ? `${d.lessons}/${d.capacity}` : '';
        const cls = ['day', d.off && 'off', past && 'past', d.date === today && 'today', d.date === S.selDate && 'sel', studentMode && open(d) && 'free-dot'].filter(Boolean).join(' ');
        return `<button class="${cls}" data-l="${studentMode ? 0 : loadLevel(d)}" data-date="${d.date}" ${studentMode && (past || d.off) ? 'disabled' : ''}>
          <span class="n">${Number(d.date.slice(8))}</span><span class="meta">${meta}</span></button>`;
      }).join('')}
    </div>
    ${studentMode
      ? '<div class="legend"><span><i class="dot-ok"></i>есть свободные окна</span><span><i class="hatch"></i>выходной</span></div>'
      : `<div class="legend"><span>Загрузка:</span><span class="scale">${[0, 1, 2, 3, 4].map((i) => `<i style="background:var(--load-${i})"></i>`).join('')}</span><span>0 → 100%</span><span><i class="hatch"></i>выходной</span></div>`}`;
  container.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => {
    S.month = nextYm(ym, Number(b.dataset.m));
    monthCalendar(container, { onPick, studentMode });
  });
  container.querySelectorAll('[data-date]').forEach((b) => b.onclick = () => {
    S.selDate = b.dataset.date;
    container.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel');
    haptic();
    onPick(b.dataset.date, days[b.dataset.date]);
  });
}

// =====================================================================
// УЧЕНИК
// =====================================================================
const studentTabs = [
  { id: 'book', icon: '📅', label: 'Запись' },
  { id: 'my', icon: '📋', label: 'Мои уроки' },
  { id: 'pay', icon: '💳', label: 'Оплата' },
  { id: 'notif', icon: '🔔', label: 'Уведомления' },
];

async function studentBook() {
  view.innerHTML = `
    <section class="card" id="cal"></section>
    <section class="card" id="slots"><div class="empty-state"><div>👆</div>Выберите день в календаре</div></section>
    <section class="card small muted">ℹ️ ${esc(S.me.settings.rules)}</section>`;
  await monthCalendar($('#cal'), { studentMode: true, onPick: renderSlots });
  if (S.selDate) { const days = await loadMonth(S.selDate.slice(0, 7)); renderSlots(S.selDate, days[S.selDate]); }
}
/** Слоты берутся из уже загруженного месяца — переключение дат мгновенное. */
function renderSlots(date, day) {
  const box = $('#slots');
  const slots = (day?.slots || []).filter((s) => !s.past || s.busy);
  let chosen = null;
  box.innerHTML = `
    <div class="card-head"><h2>${fmt(date)}</h2><span class="muted small">${S.me.settings.lesson_duration} мин · ${money(S.me.price)}</span></div>
    ${slots.some((s) => s.free) ? `<div class="slots">${slots.map((s) => `<button class="slot" data-t="${s.start}" ${s.free ? '' : 'disabled'}>${s.start}</button>`).join('')}</div>
      <button class="btn primary block" id="bookBtn" style="margin-top:14px" disabled>Выберите время</button>`
      : '<div class="empty-state"><div>🌙</div>Свободных окон нет</div>'}`;
  box.querySelectorAll('.slot').forEach((b) => b.onclick = () => {
    box.querySelectorAll('.slot.on').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    chosen = b.dataset.t;
    haptic();
    const btn = $('#bookBtn');
    btn.disabled = false;
    btn.textContent = `Записаться на ${chosen}`;
  });
  const btn = $('#bookBtn');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try {
      const b = await run(() => api('/api/book', { date, start: chosen }));
      toast(b.status === 'confirmed' ? '✅ Вы записаны!' : '⏳ Заявка отправлена преподавателю');
      tg?.HapticFeedback?.notificationOccurred('success');
      S.monthCache.delete(date.slice(0, 7));
      studentBook();
    } catch { btn.disabled = false; }
  };
}

async function studentMy() {
  const d = await api('/api/my');
  updateBadge(d.balance);
  const past = d.history.filter((b) => !d.upcoming.some((u) => u.id === b.id));
  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Ближайшие уроки</h2></div>
      <div class="list">${d.upcoming.length ? d.upcoming.map((b) => `
        <div class="item static"><div><div class="t">${fmt(b.date)}, ${b.start}</div><div class="s"><span class="pill ${b.status}">${STATUS[b.status]}</span></div></div>
        <button class="btn bad sm" data-cancel="${b.id}">Отменить</button></div>`).join('')
        : '<div class="empty-state"><div>📭</div>Пока ничего не запланировано</div>'}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>История и домашка</h2></div>
      <div class="list">${past.length ? past.map((b) => `
        <div class="item static"><div><div class="t">${fmt(b.date)}, ${b.start}${b.topic ? ` · ${esc(b.topic)}` : ''}</div>
        ${b.homework ? `<div class="s">📚 ${esc(b.homework)}</div>` : ''}</div><span class="pill ${b.status}">${STATUS[b.status]}</span></div>`).join('')
        : '<div class="empty-state small">Здесь появятся прошедшие уроки</div>'}</div>
    </section>`;
  view.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
    if (!(await confirmBox('Отменить урок?'))) return;
    const r = await run(() => api('/api/cancel', { id: b.dataset.cancel }));
    toast(r.late ? 'Отменено (поздняя отмена — урок списан)' : 'Урок отменён');
    S.monthCache.clear();
    studentMy();
  });
}

async function studentPay() {
  const d = await api('/api/my');
  updateBadge(d.balance);
  const st = S.me.settings;
  view.innerHTML = `
    <div class="kpis two-col">
      <div class="kpi"><span>Оплачено уроков</span><b class="${d.balance < 1 ? 'neg' : ''}">${d.balance}</b></div>
      <div class="kpi"><span>Цена урока</span><b>${money(d.price)}</b></div>
    </div>
    ${d.balance < 1 ? '<section class="card warn-card"><b>💳 Пора пополнить баланс.</b> Чтобы провести следующее занятие, оплатите урок или пакет уроков.</section>' : ''}
    <section class="card">
      <div class="card-head"><h2>Реквизиты для оплаты</h2></div>
      <div class="pre">${esc(st.payment_details)}</div>
      <button class="btn primary block" id="sendRcpt" style="margin-top:14px">📎 Отправить чек</button>
      <div class="muted small" style="margin-top:8px">Откроется чат с ботом — пришлите туда скриншот перевода. Преподаватель подтвердит оплату, и баланс обновится.</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>История оплат</h2></div>
      <div class="list">${d.payments.length ? d.payments.map((p) => `<div class="item static"><div><div class="t">${money(p.amount)}</div><div class="s">${p.created_at.slice(0, 10)}${p.note ? ' · ' + esc(p.note) : ''}</div></div><span class="pill done">+${p.lessons} ${lessonsWord(p.lessons)}</span></div>`).join('')
        : '<div class="empty-state small">Оплат пока не было</div>'}
      ${d.receipts.filter((r) => r.status === 'pending').map((r) => `<div class="item static"><div><div class="t">Чек отправлен</div><div class="s">${r.created_at.slice(0, 16)}</div></div><span class="pill pending">на проверке</span></div>`).join('')}</div>
    </section>`;
  $('#sendRcpt').onclick = async () => {
    await run(() => api('/api/receipt-start', {}));
    toast('Пришлите чек в чат с ботом');
    if (tg?.close) setTimeout(() => tg.close(), 700);
  };
}

async function studentNotif() {
  const d = await api('/api/my');
  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Уведомления</h2></div>
      <p class="muted small" style="margin-top:0">Выключите те напоминания, которые вам не нужны. Остальные продолжат приходить.</p>
      <div class="list">${d.notify_types.map(([k, title, desc]) => `
        <label class="item toggle"><div><div class="t">${title}</div><div class="s">${desc}</div></div>
          <input type="checkbox" data-k="${k}" ${d.notify[k] ? 'checked' : ''}><span class="sw"></span></label>`).join('')}</div>
      <p class="muted small">Напоминания об оплате и сообщения от преподавателя приходят всегда.</p>
    </section>`;
  view.querySelectorAll('[data-k]').forEach((cb) => cb.onchange = () =>
    run(() => api('/api/notify', { key: cb.dataset.k, value: cb.checked }), cb.checked ? 'Включено' : 'Выключено').catch(() => { cb.checked = !cb.checked; }));
}
function updateBadge(balance) { $('#badge').textContent = `💳 ${balance} ${lessonsWord(balance)}`; }

// =====================================================================
// ПРЕПОДАВАТЕЛЬ
// =====================================================================
const adminTabs = [
  { id: 'dash', icon: '🏠', label: 'Обзор' },
  { id: 'cal', icon: '🗓', label: 'Расписание' },
  { id: 'students', icon: '👥', label: 'Ученики' },
  { id: 'log', icon: '🧾', label: 'Журнал' },
  { id: 'settings', icon: '⚙️', label: 'Настройки' },
];

function presetRange(key) {
  const t = S.me.today.date;
  const wd = (parse(t).getUTCDay() + 6) % 7;
  const ym = t.slice(0, 7);
  return {
    week: [addDays(t, -wd), addDays(t, 6 - wd)],
    month: monthBounds(ym),
    prev: monthBounds(nextYm(ym, -1)),
    d30: [addDays(t, -29), t],
    year: [`${t.slice(0, 4)}-01-01`, `${t.slice(0, 4)}-12-31`],
  }[key];
}

async function adminDash() {
  S.statRange ||= { key: 'month', range: presetRange('month') };
  const [from, to] = S.statRange.range;
  const today = S.me.today.date;
  const [st, week, pending, receipts, todayDay] = await Promise.all([
    api(`/api/admin/stats?from=${from}&to=${to}`),
    api(`/api/month?from=${today}&to=${addDays(today, 6)}`),
    api('/api/admin/pending'),
    api('/api/admin/receipts'),
    api(`/api/admin/day?date=${today}`),
  ]);
  const wkLoad = week.reduce((a, d) => a + d.lessons, 0) / Math.max(1, week.reduce((a, d) => a + d.capacity, 0));
  const maxWd = Math.max(1, ...st.byWeekday);
  const maxDay = Math.max(1, ...st.daily.map((d) => d.lessons));
  const todays = todayDay.bookings.filter((b) => !['cancelled', 'rejected'].includes(b.status));
  setPendingDot(pending.length + receipts.length);
  const presets = [['week', 'Неделя'], ['month', 'Месяц'], ['prev', 'Прошлый месяц'], ['d30', '30 дней'], ['year', 'Год'], ['custom', 'Свои даты']];
  view.innerHTML = `
    <section class="card filter">
      <div class="chips">${presets.map(([k, l]) => `<button class="chip ${S.statRange.key === k ? 'on' : ''}" data-p="${k}">${l}</button>`).join('')}</div>
      <div class="two range ${S.statRange.key === 'custom' ? '' : 'hidden'}">
        <div class="field"><label>С</label><input type="date" id="rf" value="${from}"></div>
        <div class="field"><label>По</label><input type="date" id="rt" value="${to}"></div>
      </div>
      <div class="muted small">Период: <b>${fmt(from, { day: 'numeric', month: 'short', year: 'numeric' })} — ${fmt(to, { day: 'numeric', month: 'short', year: 'numeric' })}</b></div>
    </section>
    <div class="kpis">
      <div class="kpi"><span>Проведено</span><b>${st.done}</b></div>
      <div class="kpi"><span>Заработано</span><b>${money(st.earned)}</b></div>
      <div class="kpi"><span>Оплачено</span><b>${money(st.income)}</b></div>
      <div class="kpi"><span>Впереди</span><b>${st.upcoming}</b></div>
    </div>
    ${receipts.length ? `<section class="card"><div class="card-head"><h2>🧾 Чеки на проверке</h2><span class="pill pending">${receipts.length}</span></div>
      <div class="list">${receipts.map((r) => `<button class="item" data-rc="${r.id}"><div><div class="t">${esc(r.name)}</div><div class="s">${r.created_at.slice(0, 16)}${r.caption ? ' · ' + esc(r.caption) : ''}</div></div><span class="pill">Открыть</span></button>`).join('')}</div></section>` : ''}
    ${pending.length ? `<section class="card"><div class="card-head"><h2>⏳ Заявки</h2><span class="pill pending">${pending.length}</span></div>
      <div class="list">${pending.slice(0, 4).map(pendingRow).join('')}
      ${pending.length > 4 ? `<button class="btn ghost sm" id="allPending">Показать все (${pending.length})</button>` : ''}</div></section>` : ''}
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>Уроки по дням</h2><span class="muted small">загрузка ${Math.round(st.load * 100)}%</span></div>
        <div class="daily">${st.daily.length <= 62 ? st.daily.map((d) => `<div class="dcol ${d.off ? 'off' : ''}" title="${d.date}: ${d.lessons}"><i style="height:${(d.lessons / maxDay) * 100}%"></i></div>`).join('') : '<span class="muted small">Слишком длинный период для графика по дням</span>'}</div>
        <div class="daily-axis muted small"><span>${fmt(from, { day: 'numeric', month: 'short' })}</span><span>${fmt(to, { day: 'numeric', month: 'short' })}</span></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Отмены и пропуски</h2></div>
        <div class="stat-rows">
          <div><span>Отменил ученик</span><b>${st.cancelled_student}</b></div>
          <div><span>Отменил преподаватель</span><b>${st.cancelled_teacher}</b></div>
          <div><span>Отклонённые заявки</span><b>${st.rejected}</b></div>
          <div><span>Неявки</span><b>${st.no_show}</b></div>
          <div><span>Ученики без оплаченных уроков</span><b class="${st.debtors ? 'neg' : ''}">${st.debtors}</b></div>
        </div>
      </section>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>Популярные дни</h2></div>
        <div class="hbars">${st.byWeekday.map((c, i) => `<div class="hbar"><span>${WD[i]}</span><div class="track"><i style="width:${(c / maxWd) * 100}%"></i></div><span>${c}</span></div>`).join('')}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Самые активные</h2></div>
        <div class="stat-rows">${st.top.length ? st.top.map((t) => `<div><span>${esc(t.name)}</span><b>${t.c}</b></div>`).join('') : '<span class="muted small">Нет проведённых уроков за период</span>'}</div>
      </section>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>Ближайшие 7 дней</h2><span class="muted small">${Math.round(wkLoad * 100)}%</span></div>
        <div class="week">${week.map((d) => `<div class="bar" data-go="${d.date}">
          <b>${d.off ? '—' : d.lessons}</b>
          <div class="col ${d.off ? 'hatch-bg' : ''}"><div class="fill" style="height:${Math.round(d.load * 100)}%"></div></div>
          <small>${WD[(parse(d.date).getUTCDay() + 6) % 7]} ${Number(d.date.slice(8))}</small></div>`).join('')}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Сегодня</h2><span class="muted small">${fmt(today)}</span></div>
        <div class="list">${todays.length ? todays.map((b) => `<button class="item" data-go="${today}"><div><div class="t">${b.start} · ${esc(b.name)}</div><div class="s">${esc(b.level || '')}</div></div><span class="pill ${b.status}">${STATUS[b.status]}</span></button>`).join('')
          : '<div class="empty-state"><div>☕️</div>Сегодня уроков нет</div>'}</div>
      </section>
    </div>`;

  view.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => {
    const k = b.dataset.p;
    S.statRange = k === 'custom' ? { key: 'custom', range: S.statRange.range } : { key: k, range: presetRange(k) };
    adminDash();
  });
  const applyCustom = () => {
    const f = $('#rf').value, t = $('#rt').value;
    if (!f || !t) return;
    if (f > t) return toast('Дата «С» позже даты «По»');
    S.statRange = { key: 'custom', range: [f, t] };
    adminDash();
  };
  $('#rf').onchange = applyCustom;
  $('#rt').onchange = applyCustom;
  bindPending(view, adminDash);
  view.querySelectorAll('[data-rc]').forEach((b) => b.onclick = () => receiptSheet(receipts.find((r) => r.id == b.dataset.rc)));
  const all = $('#allPending');
  if (all) all.onclick = () => openSheet(`<h2>Все заявки</h2><div class="list">${pending.map(pendingRow).join('')}</div>`, (sh) => bindPending(sh, () => { closeSheet(); adminDash(); }));
  view.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => { S.selDate = b.dataset.go; S.month = b.dataset.go.slice(0, 7); go('cal'); });
}
const pendingRow = (b) => `<div class="item static"><div><div class="t">${esc(b.name)}</div><div class="s">${fmt(b.date)}, ${b.start}</div></div>
  <div class="row nowrap"><button class="btn ok sm" data-st="confirmed" data-id="${b.id}">✓</button><button class="btn bad sm" data-st="rejected" data-id="${b.id}">✕</button></div></div>`;
function bindPending(root, after) {
  root.querySelectorAll('[data-st]').forEach((b) => b.onclick = () =>
    run(() => api('/api/admin/status', { id: b.dataset.id, status: b.dataset.st }), b.dataset.st === 'confirmed' ? 'Подтверждено' : 'Заявка отклонена').then(() => { S.monthCache.clear(); after(); }));
}

async function receiptSheet(r) {
  const price = r.price ?? Number(S.settings?.price || S.me.settings.price);
  openSheet(`
    <h2>Чек от ${esc(r.name)}</h2>
    <div class="muted small">${r.created_at.slice(0, 16)} · баланс сейчас: ${r.balance} ${lessonsWord(r.balance)} · цена урока ${money(price)}</div>
    ${r.caption ? `<div class="pre" style="margin-top:8px">${esc(r.caption)}</div>` : ''}
    <div class="receipt" id="rcImg"><div class="skeleton"></div></div>
    <div class="form">
      <div class="two">
        <div class="field"><label>Уроков зачислить</label><input id="rl" type="number" inputmode="numeric" min="1" value="4"></div>
        <div class="field"><label>Сумма, ${S.cur}</label><input id="ra" type="number" inputmode="numeric" value="${4 * price}"></div>
      </div>
      <div class="two"><button class="btn ok" id="rOk">✅ Зачислить</button><button class="btn bad" id="rNo">Отклонить</button></div>
    </div>`, async () => {
    $('#rl').oninput = () => { $('#ra').value = (Number($('#rl').value) || 0) * price; };
    $('#rOk').onclick = () => run(() => api('/api/admin/receipt', { id: r.id, action: 'accept', lessons: Number($('#rl').value), amount: $('#ra').value }), 'Оплата зачислена').then(() => { closeSheet(); adminDash(); });
    $('#rNo').onclick = async () => { if (await confirmBox('Отклонить чек? Ученик получит уведомление.')) run(() => api('/api/admin/receipt', { id: r.id, action: 'reject' }), 'Чек отклонён').then(() => { closeSheet(); adminDash(); }); };
    try {
      const img = await receiptImage(r.id);
      $('#rcImg').innerHTML = img.type.startsWith('image/') ? `<img src="${img.url}" alt="Чек">` : `<a class="btn ghost block" href="${img.url}" target="_blank" rel="noopener">Открыть файл чека</a>`;
    } catch (e) { $('#rcImg').innerHTML = `<div class="muted small">${esc(e.message)}</div>`; }
  });
}

async function adminCal() {
  view.innerHTML = '<div class="grid-2"><section class="card" id="cal"></section><section class="card" id="day"></section></div>';
  S.selDate ||= S.me.today.date;
  await monthCalendar($('#cal'), { onPick: renderAdminDay });
  renderAdminDay(S.selDate);
}

async function renderAdminDay(date) {
  const box = $('#day');
  box.style.opacity = '.55';
  const d = await api(`/api/admin/day?date=${date}`);
  if (S.selDate !== date) return; // пользователь уже выбрал другой день
  box.style.opacity = '';
  const active = d.bookings.filter((b) => !['cancelled', 'rejected'].includes(b.status));
  const rows = [];
  const covered = new Set();
  for (const s of d.slots) {
    const b = active.find((x) => x.start < s.end && x.end > s.start);
    const bl = d.blocks.find((x) => x.start < s.end && x.end > s.start);
    if (b) { if (!covered.has('b' + b.id)) { covered.add('b' + b.id); rows.push({ t: b.start, kind: 'lesson', b }); } continue; }
    if (bl) { if (!covered.has('k' + bl.id)) { covered.add('k' + bl.id); rows.push({ t: bl.start, kind: 'block', bl }); } continue; }
    rows.push({ t: s.start, kind: 'free', s });
  }
  active.filter((b) => !covered.has('b' + b.id)).forEach((b) => rows.push({ t: b.start, kind: 'lesson', b }));
  rows.sort((a, b) => a.t.localeCompare(b.t));
  const history = d.bookings.filter((b) => ['cancelled', 'rejected'].includes(b.status));
  const isPast = (s) => date < S.me.today.date || (date === S.me.today.date && s.start <= S.me.today.time);
  box.innerHTML = `
    <div class="card-head"><div><h2>${fmt(date)}</h2><div class="muted small">${d.window ? `${d.window.start}–${d.window.end}` : 'Выходной'}${d.override ? ' · изменён вручную' : ''}</div></div>
      <button class="btn ghost sm" id="dayCfg">Настроить день</button></div>
    <div class="timeline">${rows.length ? rows.map((r) => `<div class="tl-row"><div class="tl-time">${r.t}</div>${
      r.kind === 'lesson' ? `<button class="tl-item st-${r.b.status}" data-b="${r.b.id}"><div><div style="font-weight:700">${esc(r.b.name)}${r.b.tg_id ? '' : ' 📒'}</div><div class="small muted">${r.b.start}–${r.b.end}${r.b.topic ? ' · ' + esc(r.b.topic) : ''}</div></div><span class="pill ${r.b.status}">${STATUS[r.b.status]}</span></button>`
      : r.kind === 'block' ? `<button class="tl-item block" data-bl="${r.bl.id}"><span>⛔ ${r.bl.start}–${r.bl.end} ${esc(r.bl.reason)}</span><span class="small">снять</span></button>`
      : isPast(r.s) ? '<div class="tl-item free dim"><span>прошло</span></div>'
      : `<button class="tl-item free" data-free="${r.s.start}" data-end="${r.s.end}"><span>${r.s.past ? 'свободно (ученик уже не может записаться)' : 'свободно'}</span><span class="small">＋</span></button>`
    }</div>`).join('') : '<div class="empty-state"><div>🌙</div>Нерабочий день</div>'}</div>
    ${history.length ? `<div class="muted small" style="margin-top:12px">Отменённые/отклонённые: ${history.map((b) => `${b.start} ${esc(b.name)}`).join(', ')}</div>` : ''}`;
  box.querySelector('#dayCfg').onclick = () => dayConfigSheet(date, d);
  box.querySelectorAll('[data-b]').forEach((el) => el.onclick = () => lessonSheet(d.bookings.find((b) => b.id == el.dataset.b), date));
  box.querySelectorAll('[data-bl]').forEach((el) => el.onclick = () => run(() => api('/api/admin/block', { remove: el.dataset.bl }), 'Блокировка снята').then(() => refreshCal(date)));
  box.querySelectorAll('[data-free]').forEach((el) => el.onclick = () => freeSlotSheet(date, el.dataset.free, el.dataset.end));
}
async function refreshCal(date) {
  closeSheet();
  S.monthCache.delete(date.slice(0, 7));
  await monthCalendar($('#cal'), { onPick: renderAdminDay });
  renderAdminDay(date);
}

function lessonSheet(b, date) {
  const act = (status, label, cls = '') => `<button class="btn ${cls}" data-s="${status}">${label}</button>`;
  openSheet(`
    <h2>${esc(b.name)}</h2>
    <div class="muted">${fmt(b.date)}, ${b.start}–${b.end} · <span class="pill ${b.status}">${STATUS[b.status]}</span></div>
    <div class="actions">
      ${b.status === 'pending' ? act('confirmed', '✓ Подтвердить', 'ok') + act('rejected', '✕ Отклонить', 'bad') : ''}
      ${['pending', 'confirmed'].includes(b.status) ? act('done', '🎓 Проведён', 'ok') + act('no_show', '🙈 Неявка', 'bad') + act('cancelled', 'Отменить урок', 'bad') + '<button class="btn" id="resch">🔁 Перенести</button>' : ''}
      ${['done', 'no_show', 'late_cancel'].includes(b.status) ? act('confirmed', '↩︎ Вернуть в план') : ''}
    </div>
    <div class="muted small" style="margin-top:6px">«Проведён» — ученику придёт уведомление с остатком баланса, а при нулевом балансе — напоминание об оплате.</div>
    <div class="form">
      <div class="field"><label>Тема урока</label><input id="topic" value="${esc(b.topic)}" placeholder="Present Perfect, small talk…"></div>
      <div class="field"><label>Домашнее задание</label><textarea id="hw" placeholder="Workbook p.24 ex.1–3">${esc(b.homework)}</textarea></div>
      <div class="two"><button class="btn" id="saveN">Сохранить</button><button class="btn primary" id="sendN" ${b.tg_id ? '' : 'disabled'}>Сохранить и отправить</button></div>
      <button class="btn ghost" id="openStu">👤 Карточка ученика</button>
    </div>`, (sh) => {
    sh.querySelectorAll('[data-s]').forEach((x) => x.onclick = async () => {
      if (x.dataset.s === 'cancelled' && !(await confirmBox('Отменить урок? Ученик получит уведомление.'))) return;
      run(() => api('/api/admin/status', { id: b.id, status: x.dataset.s }), 'Статус обновлён').then(() => refreshCal(date));
    });
    const save = (notify) => run(() => api('/api/admin/notes', { id: b.id, topic: $('#topic').value, homework: $('#hw').value, notify }),
      notify ? 'ДЗ отправлено ученику' : 'Сохранено').then(() => refreshCal(date));
    $('#saveN').onclick = () => save(false);
    $('#sendN').onclick = () => save(true);
    $('#openStu').onclick = () => studentSheet(b.user_id);
    const r = $('#resch');
    if (r) r.onclick = () => pickSlotSheet('Перенести урок', async (nd, nt) => {
      await run(() => api('/api/admin/reschedule', { id: b.id, date: nd, start: nt }), 'Урок перенесён');
      S.monthCache.clear();
      refreshCal(nd);
    });
  });
}

async function freeSlotSheet(date, start, end) {
  const students = await api('/api/admin/students');
  openSheet(`
    <h2>${fmt(date)}, ${start}</h2>
    <div class="form">
      <div class="field"><label>Записать ученика</label>
        <select id="stu">${students.map((s) => `<option value="${s.id}">${esc(s.name)}${s.tg_id ? '' : ' (без Telegram)'}</option>`).join('')}</select></div>
      <button class="btn primary" id="add" ${students.length ? '' : 'disabled'}>Записать</button>
      <div class="field"><label>Или закрыть время</label><input id="reason" placeholder="Причина (видно только вам)"></div>
      <button class="btn ghost" id="blk">⛔ Заблокировать ${start}–${end}</button>
    </div>`, () => {
    $('#add').onclick = () => run(() => api('/api/admin/book', { user_id: $('#stu').value, date, start }), 'Ученик записан').then(() => refreshCal(date));
    $('#blk').onclick = () => run(() => api('/api/admin/block', { date, start, end, reason: $('#reason').value }), 'Время закрыто').then(() => refreshCal(date));
  });
}

function dayConfigSheet(date, d) {
  openSheet(`
    <h2>${fmt(date)}</h2>
    <div class="form">
      <div class="two">
        <div class="field"><label>Начало</label><input type="time" id="ds" value="${d.window?.start || S.settings?.work_start || '10:00'}"></div>
        <div class="field"><label>Конец</label><input type="time" id="de" value="${d.window?.end || S.settings?.work_end || '20:00'}"></div>
      </div>
      <button class="btn primary" id="work">Рабочий день с этими часами</button>
      <button class="btn bad" id="off">Сделать выходным</button>
      ${d.override ? '<button class="btn ghost" id="reset">Вернуть обычное расписание</button>' : ''}
    </div>`, () => {
    $('#work').onclick = () => run(() => api('/api/admin/day', { date, is_off: 0, start: $('#ds').value, end: $('#de').value }), 'Сохранено').then(() => refreshCal(date));
    $('#off').onclick = () => run(() => api('/api/admin/day', { date, is_off: 1 }), 'День закрыт').then(() => refreshCal(date));
    const r = $('#reset');
    if (r) r.onclick = () => run(() => api('/api/admin/day', { date, clear: 1 }), 'Сброшено').then(() => refreshCal(date));
  });
}

function pickSlotSheet(title, onPick) {
  let date = S.me.today.date;
  const draw = async () => {
    const slots = (await api(`/api/slots?date=${date}`)).filter((s) => !s.busy && (date > S.me.today.date || s.start > S.me.today.time));
    openSheet(`
      <h2>${title}</h2>
      <div class="field" style="margin-top:12px"><label>Дата</label><input type="date" id="pd" value="${date}" min="${S.me.today.date}"></div>
      <div class="slots" style="margin-top:12px">${slots.map((s) => `<button class="slot" data-t="${s.start}">${s.start}</button>`).join('') || '<span class="muted">Нет свободных окон</span>'}</div>`, (sh) => {
      $('#pd').onchange = (e) => { date = e.target.value; draw(); };
      sh.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => onPick(date, b.dataset.t));
    });
  };
  draw();
}

// ---------- ученики ----------
async function adminStudents() {
  const list = await api('/api/admin/students');
  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Ученики · ${list.length}</h2><button class="btn primary sm" id="addStu">＋ Добавить</button></div>
      <input class="search" id="q" placeholder="Поиск по имени или @username">
      <div class="chips" style="margin-top:10px"><button class="chip on" data-f="all">Все</button><button class="chip" data-f="debt">Нужна оплата</button><button class="chip" data-f="manual">Без Telegram</button></div>
      <div class="list" id="sl" style="margin-top:10px"></div>
    </section>`;
  let filter = 'all';
  const draw = () => {
    const q = $('#q').value.toLowerCase();
    const f = list.filter((s) => `${s.name} ${s.username || ''}`.toLowerCase().includes(q))
      .filter((s) => filter === 'all' || (filter === 'debt' ? s.balance < 1 : !s.tg_id));
    $('#sl').innerHTML = f.length ? f.map((s) => `
      <button class="item" data-u="${s.id}">
        <div class="row nowrap" style="min-width:0"><div class="avatar ${s.tg_id ? '' : 'manual'}">${initials(s.name)}</div>
          <div style="min-width:0"><div class="t">${esc(s.name)} ${s.blocked ? '🚫' : ''}${s.tg_id ? '' : ' <span class="tag">без Telegram</span>'}</div>
          <div class="s">${money(s.price ?? S.me.settings.price)} · уроков: ${s.lessons_done}${s.next_lesson ? ` · след.: ${fmt(s.next_lesson.slice(0, 10), { day: 'numeric', month: 'short' })} ${s.next_lesson.slice(11)}` : ''}</div></div></div>
        <span class="pill ${s.balance < 1 ? 'neg' : ''}">${s.balance} ур.</span>
      </button>`).join('') : '<div class="empty-state"><div>👋</div>Никого не найдено</div>';
    view.querySelectorAll('[data-u]').forEach((b) => b.onclick = () => studentSheet(b.dataset.u));
  };
  $('#q').oninput = draw;
  view.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => {
    filter = b.dataset.f;
    view.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  });
  $('#addStu').onclick = addStudentSheet;
  draw();
}

function addStudentSheet() {
  openSheet(`
    <h2>Новый ученик</h2>
    <p class="muted small">Ученик добавляется только для учёта: ему ничего не отправляется в Telegram. Позже при желании можно отправить ссылку-приглашение, чтобы подключить его Telegram.</p>
    <div class="form">
      <div class="field"><label>Имя *</label><input id="nn" placeholder="Мария Иванова" autocomplete="off"></div>
      <div class="two">
        <div class="field"><label>Цена урока, ${S.cur}</label><input id="np" type="number" inputmode="numeric" placeholder="${S.me.settings.price}"></div>
        <div class="field"><label>Телефон</label><input id="nph" type="tel" placeholder="необязательно"></div>
      </div>
      <div class="two">
        <div class="field"><label>Уровень</label><input id="nl" placeholder="B1"></div>
        <div class="field"><label>Цель</label><input id="ng" placeholder="Разговорный"></div>
      </div>
      <div class="field"><label>Заметки</label><textarea id="nt"></textarea></div>
      <div class="two">
        <div class="field"><label>Оплачено уроков</label><input id="nb" type="number" inputmode="numeric" placeholder="0"></div>
        <div class="field"><label>Сумма оплаты, ${S.cur}</label><input id="nbs" type="number" inputmode="numeric" placeholder="0"></div>
      </div>
      <button class="btn primary" id="saveNew">Добавить ученика</button>
    </div>`, () => {
    $('#saveNew').onclick = async () => {
      const u = await run(() => api('/api/admin/student-add', { name: $('#nn').value, price: $('#np').value, phone: $('#nph').value, level: $('#nl').value, goal: $('#ng').value, notes: $('#nt').value }), 'Ученик добавлен');
      const n = Number($('#nb').value);
      if (n) await run(() => api('/api/admin/payment', { user_id: u.id, amount: Number($('#nbs').value) || 0, lessons: n, note: 'стартовый баланс' }));
      closeSheet();
      adminStudents();
    };
  });
}

async function studentSheet(id) {
  const d = await api(`/api/admin/student?id=${id}`);
  const u = d.user;
  const cnt = (f) => d.bookings.filter(f).length;
  const cs = cnt((b) => ['cancelled', 'late_cancel'].includes(b.status) && b.cancelled_by === 'student');
  const ct = cnt((b) => b.status === 'cancelled' && b.cancelled_by !== 'student');
  const rj = cnt((b) => b.status === 'rejected');
  const price = u.price ?? Number(S.me.settings.price);
  openSheet(`
    <div class="row nowrap"><div class="avatar ${u.tg_id ? '' : 'manual'}">${initials(u.name)}</div>
      <div><h2>${esc(u.name)}</h2><div class="muted small">${u.tg_id ? (u.username ? '@' + esc(u.username) : 'Telegram подключён') : '📒 без Telegram — только учёт'}</div></div></div>
    <div class="kpis" style="margin-top:12px">
      <div class="kpi"><span>Баланс, уроков</span><b class="${u.balance < 1 ? 'neg' : ''}">${u.balance}</b></div>
      <div class="kpi"><span>Проведено</span><b>${cnt((b) => b.status === 'done')}</b></div>
      <div class="kpi"><span>Цена урока</span><b>${money(price)}</b></div>
      <div class="kpi"><span>Оплачено всего</span><b>${money(d.payments.reduce((a, p) => a + p.amount, 0))}</b></div>
    </div>
    <div class="stat-rows" style="margin-top:10px">
      <div><span>Отменил ученик</span><b>${cs}</b></div>
      <div><span>Отменил преподаватель</span><b>${ct}</b></div>
      <div><span>Отклонённые заявки</span><b>${rj}</b></div>
      <div><span>Неявки</span><b>${cnt((b) => b.status === 'no_show')}</b></div>
    </div>
    <div class="form">
      <div class="two">
        <div class="field"><label>Индивидуальная цена, ${S.cur}</label><input id="up" type="number" inputmode="numeric" value="${u.price ?? ''}" placeholder="${S.me.settings.price} (по умолчанию)"></div>
        <div class="field"><label>Телефон</label><input id="uph" type="tel" value="${esc(u.phone)}"></div>
      </div>
      <div class="two">
        <div class="field"><label>Уровень</label><input id="lv" value="${esc(u.level)}"></div>
        <div class="field"><label>Цель</label><input id="gl" value="${esc(u.goal)}"></div>
      </div>
      <div class="field"><label>Заметки</label><textarea id="nt">${esc(u.notes)}</textarea></div>
      <div class="two"><button class="btn" id="saveU">Сохранить</button><button class="btn ${u.blocked ? 'ok' : 'bad'}" id="blkU">${u.blocked ? 'Разблокировать' : 'Заблокировать'}</button></div>
      ${u.tg_id ? '<button class="btn ghost" id="remindU">💳 Напомнить об оплате</button>' : '<button class="btn ghost" id="linkU">🔗 Ссылка-приглашение (по желанию)</button>'}
      <h3>💳 Внести оплату</h3>
      <div class="two">
        <div class="field"><label>Уроков</label><input id="pl" type="number" inputmode="numeric" placeholder="4"></div>
        <div class="field"><label>Сумма, ${S.cur}</label><input id="pa" type="number" inputmode="numeric" placeholder="${4 * price}"></div>
      </div>
      <input class="search" id="pn" placeholder="Комментарий (пакет, способ оплаты…)">
      <button class="btn primary" id="payU">Добавить оплату</button>
      <button class="btn ghost" id="bookU">➕ Записать на урок</button>
    </div>
    <h3 style="margin-top:18px">Уроки</h3>
    <div class="list" style="margin-top:8px">${d.bookings.slice(0, 20).map((b) => `<div class="item static"><div><div class="t">${fmt(b.date, { day: 'numeric', month: 'short' })}, ${b.start}${b.topic ? ' · ' + esc(b.topic) : ''}</div>${b.homework ? `<div class="s">📚 ${esc(b.homework)}</div>` : ''}</div><span class="pill ${b.status}">${STATUS[b.status]}${b.cancelled_by ? (b.cancelled_by === 'student' ? ' · ученик' : ' · вы') : ''}</span></div>`).join('') || '<span class="muted small">Пока нет</span>'}</div>
    <h3 style="margin-top:18px">Оплаты</h3>
    <div class="list" style="margin-top:8px">${d.payments.map((p) => `<div class="item static"><div><div class="t">${money(p.amount)}</div><div class="s">${p.created_at.slice(0, 10)}${p.note ? ' · ' + esc(p.note) : ''}</div></div><span class="pill done">+${p.lessons}</span></div>`).join('') || '<span class="muted small">Пока нет</span>'}</div>
    <h3 style="margin-top:18px">Журнал ученика</h3>
    <div class="log">${d.logs.slice(0, 20).map(logRow).join('') || '<span class="muted small">Пусто</span>'}</div>`, () => {
    $('#pl').oninput = () => { $('#pa').value = (Number($('#pl').value) || 0) * price; };
    $('#saveU').onclick = () => run(() => api('/api/admin/student', { id: u.id, price: $('#up').value, phone: $('#uph').value, level: $('#lv').value, goal: $('#gl').value, notes: $('#nt').value }), 'Сохранено').then(() => studentSheet(id));
    $('#blkU').onclick = () => run(() => api('/api/admin/student', { id: u.id, blocked: u.blocked ? 0 : 1 }), 'Готово').then(() => studentSheet(id));
    const rem = $('#remindU');
    if (rem) rem.onclick = () => run(() => api('/api/admin/remind-payment', { id: u.id }), 'Напоминание отправлено');
    const link = $('#linkU');
    if (link) link.onclick = async () => {
      const r = await run(() => api('/api/admin/student-link', { id: u.id }));
      try { await navigator.clipboard.writeText(r.url); toast('Ссылка скопирована'); } catch { /* покажем ниже */ }
      openSheet(`<h2>Ссылка-приглашение</h2><p class="muted small">Отправьте её ученику, только если хотите подключить его Telegram. Баланс и история сохранятся.</p><div class="pre select">${esc(r.url)}</div><button class="btn ghost block" id="back" style="margin-top:12px">Назад</button>`, () => { $('#back').onclick = () => studentSheet(id); });
    };
    $('#payU').onclick = () => {
      if (!$('#pa').value && !$('#pl').value) return toast('Укажите уроки или сумму');
      run(() => api('/api/admin/payment', { user_id: u.id, amount: Number($('#pa').value) || 0, lessons: Number($('#pl').value) || 0, note: $('#pn').value }), 'Оплата записана').then(() => studentSheet(id));
    };
    $('#bookU').onclick = () => pickSlotSheet(`Записать: ${esc(u.name)}`, async (date, start) => {
      await run(() => api('/api/admin/book', { user_id: u.id, date, start }), 'Ученик записан');
      S.monthCache.clear();
      studentSheet(id);
    });
  });
}

// ---------- журнал ----------
function logRow(l) {
  const ts = new Intl.DateTimeFormat('ru-RU', { timeZone: S.me.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date(l.ts.replace(' ', 'T') + 'Z')).replace(',', '');
  const det = Object.entries(l.details || {}).filter(([k]) => !['booking_id', 'user_id', 'receipt_id'].includes(k))
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
  return `<div class="log-row"><time>${ts}</time>
    <div><b>${ACTIONS[l.action] || l.action}</b> ${l.name ? `· ${esc(l.name)}` : l.actor_id ? '' : '· система'}
    ${det ? `<div class="muted small">${esc(det)}</div>` : ''}</div></div>`;
}
async function adminLog() {
  const logs = await api('/api/admin/logs?limit=500');
  const names = { booking: 'Уроки', payment: 'Оплаты', receipt: 'Чеки', user: 'Ученики', settings: 'Настройки', day: 'Дни', block: 'Блоки', reminder: 'Напоминания', system: 'Система', broadcast: 'Рассылки', message: 'Сообщения', export: 'Экспорт', security: 'Безопасность' };
  const groups = [...new Set(logs.map((l) => l.action.split('.')[0]))];
  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Журнал действий</h2><span class="muted small">${logs.length} записей</span></div>
      <div class="chips" style="margin-bottom:8px"><button class="chip on" data-f="">Все</button>
        ${groups.map((g) => `<button class="chip" data-f="${g}">${names[g] || g}</button>`).join('')}</div>
      <div class="log" id="lg"></div>
    </section>`;
  const draw = (f) => { $('#lg').innerHTML = logs.filter((l) => !f || l.action.startsWith(f + '.') || l.action === f).map(logRow).join('') || '<div class="empty-state">Пусто</div>'; };
  view.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { view.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); draw(b.dataset.f); });
  draw('');
}

// ---------- настройки ----------
async function adminSettings() {
  const s = await api('/api/admin/settings');
  S.settings = s;
  const days = s.work_days.split(',');
  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Расписание и правила</h2></div>
      <form class="form" id="sf">
        <div class="field"><label>Имя преподавателя</label><input name="teacher_name" value="${esc(s.teacher_name)}"></div>
        <div class="field"><label>Рабочие дни</label><div class="weekdays">${WD.map((w, i) => `<label><input type="checkbox" name="wd" value="${i + 1}" ${days.includes(String(i + 1)) ? 'checked' : ''}><span>${w}</span></label>`).join('')}</div></div>
        <div class="two">
          <div class="field"><label>Начало дня</label><input type="time" name="work_start" value="${s.work_start}"></div>
          <div class="field"><label>Конец дня</label><input type="time" name="work_end" value="${s.work_end}"></div>
        </div>
        <div class="two">
          <div class="field"><label>Длительность урока, мин</label><input type="number" name="lesson_duration" value="${s.lesson_duration}" min="15" step="5"></div>
          <div class="field"><label>Шаг сетки, мин</label><input type="number" name="slot_step" value="${s.slot_step}" min="15" step="5"></div>
        </div>
        <div class="two">
          <div class="field"><label>Цена по умолчанию</label><input type="number" name="price" value="${s.price}"></div>
          <div class="field"><label>Валюта</label><input name="currency" value="${esc(s.currency)}" maxlength="5"></div>
        </div>
        <div class="two">
          <div class="field"><label>Бесплатная отмена за, ч</label><input type="number" name="cancel_hours" value="${s.cancel_hours}" min="0"></div>
          <div class="field"><label>Бронь не позже чем за, ч</label><input type="number" name="min_hours_before" value="${s.min_hours_before}" min="0"></div>
        </div>
        <div class="two">
          <div class="field"><label>Запись на N дней вперёд</label><input type="number" name="days_ahead" value="${s.days_ahead}" min="1"></div>
          <div class="field"><label>Макс. уроков в плане у ученика</label><input type="number" name="max_active" value="${s.max_active}" min="1"></div>
        </div>
        <div class="field"><label>Подтверждение броней</label>
          <select name="auto_confirm"><option value="0" ${s.auto_confirm === '0' ? 'selected' : ''}>Вручную — я подтверждаю каждую</option><option value="1" ${s.auto_confirm === '1' ? 'selected' : ''}>Автоматически</option></select></div>
        <div class="field"><label>Реквизиты для оплаты</label><textarea name="payment_details" rows="4">${esc(s.payment_details)}</textarea></div>
        <div class="field"><label>Правила для учеников</label><textarea name="rules">${esc(s.rules)}</textarea></div>
        <button class="btn primary" type="submit">Сохранить настройки</button>
      </form>
    </section>
    <section class="card">
      <div class="card-head"><h2>Экспорт данных (CSV для Excel)</h2></div>
      <div class="row">${[['bookings', 'Уроки'], ['students', 'Ученики'], ['payments', 'Оплаты'], ['logs', 'Журнал']].map(([k, l]) => `<button class="btn ghost sm" data-exp="${k}">${l}</button>`).join('')}</div>
      <div class="muted small" style="margin-top:8px">Файл придёт вам в чат с ботом.</div>
    </section>`;
  view.querySelectorAll('[data-exp]').forEach((b) => b.onclick = () => run(() => api('/api/admin/export-to-chat', { kind: b.dataset.exp }), '📤 Файл отправлен в чат с ботом'));
  $('#sf').onsubmit = (e) => {
    e.preventDefault();
    document.activeElement?.blur?.();
    const fd = new FormData(e.target);
    const body = Object.fromEntries([...fd.entries()].filter(([k]) => k !== 'wd'));
    body.work_days = fd.getAll('wd').join(',');
    run(() => api('/api/admin/settings', body), 'Настройки сохранены').then((r) => { S.settings = r; S.cur = r.currency; S.monthCache.clear(); });
  };
}

// =====================================================================
// router
// =====================================================================
const RENDER = { book: studentBook, my: studentMy, pay: studentPay, notif: studentNotif, dash: adminDash, cal: adminCal, students: adminStudents, log: adminLog, settings: adminSettings };
function setPendingDot(n) {
  const b = $('#tabs [data-tab="dash"] span');
  if (!b) return;
  b.classList.toggle('dot', n > 0);
  b.dataset.n = n;
}
async function go(tab) {
  S.tab = tab;
  closeSheet();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  view.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try { await RENDER[tab](); } catch (e) { view.innerHTML = `<div class="card empty-state"><div>⚠️</div>${esc(e.message)}</div>`; }
  window.scrollTo({ top: 0 });
}

(async function init() {
  try {
    S.me = await api('/api/me');
  } catch (e) {
    view.innerHTML = `<div class="card empty-state"><div>🔒</div>${esc(e.message)}</div>`;
    $('#hello').textContent = '';
    return;
  }
  S.cur = S.me.settings.currency || '₽';
  S.month = S.me.today.date.slice(0, 7);
  const admin = S.me.admin;
  $('#hello').textContent = admin ? 'Панель преподавателя' : `Преподаватель — ${S.me.settings.teacher_name}`;
  $('#title').textContent = admin ? S.me.settings.teacher_name : 'Уроки английского';
  if (admin) $('#badge').textContent = '🛠 Админ'; else updateBadge(S.me.user.balance);
  const tabs = admin ? adminTabs : studentTabs;
  $('#tabs').innerHTML = tabs.map((t) => `<button data-tab="${t.id}"><span>${t.icon}</span>${t.label}</button>`).join('');
  $('#tabs').querySelectorAll('button').forEach((b) => b.onclick = () => { haptic(); go(b.dataset.tab); });
  if (admin) api('/api/admin/settings').then((s) => { S.settings = s; }).catch(() => {});
  else loadMonth(S.month).catch(() => {}); // прогрев календаря
  go(tabs[0].id);
})();
