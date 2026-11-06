'use strict';
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
if (tg?.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const qs = new URLSearchParams(location.search);
const devAs = qs.get('as');
// Адрес API: на GitHub Pages его передаёт бот (?api=…). Разрешены только туннели Cloudflare и свой домен.
const API_BASE = (() => {
  const a = qs.get('api');
  if (a && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(a)) return a;
  return location.origin;
})();

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
    throw new Error('Сервер недоступен. Закройте приложение и откройте снова через кнопку «Календарь» в боте.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка');
  return data;
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (s, n) => iso(new Date(parse(s).getTime() + n * 864e5));
const fmt = (s, o = { weekday: 'short', day: 'numeric', month: 'long' }) => new Intl.DateTimeFormat('ru-RU', { ...o, timeZone: 'UTC' }).format(parse(s));
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const STATUS = {
  pending: 'ждёт подтверждения', confirmed: 'подтверждён', cancelled: 'отменён', late_cancel: 'поздняя отмена',
  rejected: 'отклонён', done: 'проведён', no_show: 'неявка',
};
const ACTIONS = {
  'booking.create': 'Новая бронь', 'booking.confirmed': 'Подтверждение', 'booking.rejected': 'Отклонение',
  'booking.cancelled': 'Отмена', 'booking.late_cancel': 'Поздняя отмена', 'booking.done': 'Урок проведён',
  'booking.no_show': 'Неявка', 'booking.reschedule': 'Перенос', 'booking.notes': 'Тема / ДЗ',
  'payment.add': 'Оплата', 'user.start': 'Открыл бота', 'user.registered': 'Регистрация', 'user.update': 'Изменение ученика',
  'settings.update': 'Настройки', 'day.override': 'Изменение дня', 'day.override_clear': 'Сброс дня',
  'block.add': 'Блокировка времени', 'block.remove': 'Снятие блокировки', 'broadcast': 'Рассылка',
  'message.sent': 'Сообщение ученику', 'export': 'Экспорт', 'reminder.rem24': 'Напоминание за сутки',
  'reminder.rem1': 'Напоминание за час', 'system.start': 'Запуск системы',
};
const loadLevel = (d) => (d.off ? -1 : d.load === 0 ? 0 : d.load < 0.34 ? 1 : d.load < 0.67 ? 2 : d.load < 1 ? 3 : 4);
const initials = (n) => (n || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const haptic = (t = 'light') => tg?.HapticFeedback?.impactOccurred(t);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2400);
}
function openSheet(html, onMount) {
  const sh = $('#sheet');
  sh.innerHTML = html;
  document.body.classList.add('sheet-open');
  onMount?.(sh);
}
function closeSheet() { document.body.classList.remove('sheet-open'); }
$('#backdrop').onclick = closeSheet;
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); haptic('medium'); return r; } catch (e) { toast('⚠️ ' + e.message); throw e; }
}

// ---------- state ----------
const S = { me: null, tab: null, month: null, selDate: null };

// ---------- month calendar (общий) ----------
async function monthCalendar(container, { onPick, studentMode }) {
  const [y, m] = S.month.split('-').map(Number);
  const first = `${y}-${pad(m)}-01`;
  const last = iso(new Date(Date.UTC(y, m, 0)));
  const days = await api(`/api/calendar?from=${first}&to=${last}`);
  const lead = (parse(first).getUTCDay() + 6) % 7;
  const today = S.me.today.date;
  const maxDate = addDays(today, Number(S.me.settings.days_ahead));
  container.innerHTML = `
    <div class="cal-head">
      <button class="icon-btn" data-m="-1" aria-label="Предыдущий месяц">‹</button>
      <h2>${fmt(first, { month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '')}</h2>
      <button class="icon-btn" data-m="1" aria-label="Следующий месяц">›</button>
    </div>
    <div class="cal">
      ${WD.map((w) => `<div class="wd">${w}</div>`).join('')}
      ${'<div class="day empty"></div>'.repeat(lead)}
      ${days.map((d) => {
        const past = d.date < today;
        const l = loadLevel(d);
        const meta = d.off ? 'вых' : studentMode ? (d.free && !past && d.date <= maxDate ? `${d.free} св.` : '') : d.lessons ? `${d.lessons}/${d.capacity}` : '';
        const cls = ['day', d.off && 'off', past && 'past', d.date === today && 'today', d.date === S.selDate && 'sel',
          studentMode && d.free && !past && d.date <= maxDate && 'free-dot'].filter(Boolean).join(' ');
        return `<button class="${cls}" data-l="${studentMode ? 0 : l}" data-date="${d.date}" ${studentMode && (past || d.off) ? 'disabled' : ''}>
          <span class="n">${Number(d.date.slice(8))}</span><span class="meta">${meta}</span></button>`;
      }).join('')}
    </div>
    ${studentMode
      ? `<div class="legend"><span><i style="background:var(--ok);border-radius:50%;width:8px;height:8px"></i>есть свободные окна</span><span><i style="background:repeating-linear-gradient(135deg,var(--surface-2) 0 4px,transparent 4px 8px)"></i>выходной</span></div>`
      : `<div class="legend"><span>Загрузка:</span><span class="scale">${[0, 1, 2, 3, 4].map((i) => `<i style="background:var(--load-${i})"></i>`).join('')}</span><span>0 → 100%</span>
         <span><i style="background:repeating-linear-gradient(135deg,var(--surface-2) 0 4px,transparent 4px 8px)"></i>выходной</span></div>`}`;
  container.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => {
    const d = new Date(Date.UTC(y, m - 1 + Number(b.dataset.m), 1));
    S.month = iso(d).slice(0, 7);
    monthCalendar(container, { onPick, studentMode });
  });
  container.querySelectorAll('[data-date]').forEach((b) => b.onclick = () => {
    S.selDate = b.dataset.date;
    container.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel');
    haptic();
    onPick(b.dataset.date);
  });
}

// =====================================================================
// STUDENT
// =====================================================================
const studentTabs = [
  { id: 'book', icon: '📅', label: 'Запись' },
  { id: 'my', icon: '📋', label: 'Мои уроки' },
];

async function studentBook() {
  view.innerHTML = `
    <section class="card" id="cal"></section>
    <section class="card" id="slots"><div class="empty-state"><div>👆</div>Выберите день в календаре</div></section>
    <section class="card small muted">ℹ️ ${esc(S.me.settings.rules)}</section>`;
  await monthCalendar($('#cal'), { studentMode: true, onPick: renderSlots });
  if (S.selDate) renderSlots(S.selDate);
}
async function renderSlots(date) {
  const box = $('#slots');
  const slots = await api(`/api/slots?date=${date}`);
  let chosen = null;
  box.innerHTML = `
    <div class="card-head"><h2>${fmt(date)}</h2><span class="muted small">${S.me.settings.lesson_duration} мин · ${S.me.settings.price} ₽</span></div>
    ${slots.length ? `<div class="slots">${slots.map((s) => `<button class="slot" data-t="${s.start}" ${s.free ? '' : 'disabled'}>${s.start}</button>`).join('')}</div>
      <button class="btn primary block" id="bookBtn" style="margin-top:14px" disabled>Выберите время</button>`
      : '<div class="empty-state"><div>🌙</div>В этот день уроков нет</div>'}`;
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
      studentBook();
    } catch { btn.disabled = false; }
  };
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function studentMy() {
  const d = await api('/api/my');
  $('#badge').textContent = `💳 ${d.balance} ур.`;
  const past = d.history.filter((b) => !d.upcoming.some((u) => u.id === b.id));
  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Ближайшие уроки</h2></div>
      <div class="list">${d.upcoming.length ? d.upcoming.map((b) => `
        <div class="item"><div><div class="t">${fmt(b.date)}, ${b.start}</div><div class="s"><span class="pill ${b.status}">${STATUS[b.status]}</span></div></div>
        <button class="btn bad sm" data-cancel="${b.id}">Отменить</button></div>`).join('')
        : '<div class="empty-state"><div>📭</div>Пока ничего не запланировано</div>'}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>История и домашка</h2></div>
      <div class="list">${past.length ? past.map((b) => `
        <div class="item" style="cursor:default"><div><div class="t">${fmt(b.date)}, ${b.start}${b.topic ? ` · ${esc(b.topic)}` : ''}</div>
        ${b.homework ? `<div class="s">📚 ${esc(b.homework)}</div>` : ''}</div><span class="pill ${b.status}">${STATUS[b.status]}</span></div>`).join('')
        : '<div class="empty-state small">Здесь появятся прошедшие уроки</div>'}</div>
    </section>`;
  view.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = () => {
    const ok = () => run(() => api('/api/cancel', { id: b.dataset.cancel })).then((r) => { toast(r.late ? 'Отменено (поздняя отмена — урок списан)' : 'Урок отменён'); studentMy(); });
    if (tg?.showConfirm) tg.showConfirm('Отменить урок?', (yes) => yes && ok());
    else if (confirm('Отменить урок?')) ok();
  });
}

// =====================================================================
// ADMIN
// =====================================================================
const adminTabs = [
  { id: 'dash', icon: '🏠', label: 'Обзор' },
  { id: 'cal', icon: '🗓', label: 'Календарь' },
  { id: 'students', icon: '👥', label: 'Ученики' },
  { id: 'log', icon: '🧾', label: 'Журнал' },
  { id: 'settings', icon: '⚙️', label: 'Настройки' },
];

async function adminDash() {
  const today = S.me.today.date;
  const monthStart = today.slice(0, 8) + '01';
  const [st, week, pending, todayDay] = await Promise.all([
    api(`/api/admin/stats?from=${monthStart}&to=${today}`),
    api(`/api/calendar?from=${today}&to=${addDays(today, 6)}`),
    api('/api/admin/pending'),
    api(`/api/admin/day?date=${today}`),
  ]);
  const wkLoad = week.reduce((a, d) => a + d.lessons, 0) / Math.max(1, week.reduce((a, d) => a + d.capacity, 0));
  const maxWd = Math.max(1, ...st.byWeekday);
  const todays = todayDay.bookings.filter((b) => !['cancelled', 'rejected'].includes(b.status));
  setPendingDot(pending.length);
  view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Проведено в месяце</span><b>${st.done}</b></div>
      <div class="kpi"><span>Впереди</span><b>${st.upcoming}</b></div>
      <div class="kpi"><span>Оплачено, ₽</span><b>${st.income.toLocaleString('ru-RU')}</b></div>
      <div class="kpi"><span>Учеников</span><b>${st.students}</b></div>
    </div>
    ${pending.length ? `<section class="card"><div class="card-head"><h2>⏳ Заявки</h2><span class="pill pending">${pending.length}</span></div>
      <div class="list">${pending.slice(0, 4).map((b) => `<div class="item" style="cursor:default"><div><div class="t">${esc(b.name)}</div><div class="s">${fmt(b.date)}, ${b.start}</div></div>
        <div class="row"><button class="btn ok sm" data-st="confirmed" data-id="${b.id}">✓</button><button class="btn bad sm" data-st="rejected" data-id="${b.id}">✕</button></div></div>`).join('')}
      ${pending.length > 4 ? `<button class="btn ghost sm" id="allPending">Показать все (${pending.length})</button>` : ''}</div></section>` : ''}
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>Загрузка на 7 дней</h2><span class="muted small">${Math.round(wkLoad * 100)}%</span></div>
        <div class="week">${week.map((d) => `<div class="bar" data-go="${d.date}" title="${d.lessons}/${d.capacity}">
          <b>${d.off ? '—' : d.lessons}</b>
          <div class="col" style="${d.off ? 'background:repeating-linear-gradient(135deg,var(--surface-2) 0 4px,transparent 4px 8px)' : ''}"><div class="fill" style="height:${Math.round(d.load * 100)}%"></div></div>
          <small>${WD[(parse(d.date).getUTCDay() + 6) % 7]} ${Number(d.date.slice(8))}</small></div>`).join('')}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Сегодня</h2><span class="muted small">${fmt(today)}</span></div>
        <div class="list">${todays.length ? todays.map((b) => `<button class="item" data-go="${today}"><div><div class="t">${b.start} · ${esc(b.name)}</div><div class="s">${esc(b.level || '')}</div></div><span class="pill ${b.status}">${STATUS[b.status]}</span></button>`).join('')
          : '<div class="empty-state"><div>☕️</div>Сегодня уроков нет</div>'}</div>
      </section>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>Популярные дни</h2><span class="muted small">этот месяц</span></div>
        <div class="hbars">${st.byWeekday.map((c, i) => `<div class="hbar"><span>${WD[i]}</span><div class="track"><i style="width:${(c / maxWd) * 100}%"></i></div><span>${c}</span></div>`).join('')}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Месяц</h2></div>
        <div class="row" style="gap:18px">
          <div class="ring" style="--p:${Math.round(st.load * 100)}"><div><div><b>${Math.round(st.load * 100)}%</b><div class="small muted">загрузка</div></div></div></div>
          <div class="small" style="display:grid;gap:4px">
            <div>❌ Отмены: <b>${st.cancelled}</b></div><div>🙈 Неявки: <b>${st.no_show}</b></div>
            ${st.top.length ? `<div class="muted" style="margin-top:6px">Самые активные</div>${st.top.map((t) => `<div>${esc(t.name)} — <b>${t.c}</b></div>`).join('')}` : ''}
          </div>
        </div>
      </section>
    </div>`;
  view.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => run(() => api('/api/admin/status', { id: b.dataset.id, status: b.dataset.st }), 'Готово').then(adminDash));
  const all = $('#allPending');
  if (all) all.onclick = () => openSheet(`<h2>Все заявки</h2><div class="list">${pending.map((b) => `<div class="item" style="cursor:default"><div><div class="t">${esc(b.name)}</div><div class="s">${fmt(b.date)}, ${b.start}</div></div>
    <div class="row"><button class="btn ok sm" data-st="confirmed" data-id="${b.id}">✓</button><button class="btn bad sm" data-st="rejected" data-id="${b.id}">✕</button></div></div>`).join('')}</div>`, (sh) =>
    sh.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => run(() => api('/api/admin/status', { id: b.dataset.id, status: b.dataset.st }), 'Готово').then(() => { b.closest('.item').remove(); adminDash(); })));
  view.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => { S.selDate = b.dataset.go; S.month = b.dataset.go.slice(0, 7); go('cal'); });
}

async function adminCal() {
  view.innerHTML = `<div class="grid-2"><section class="card" id="cal"></section><section class="card" id="day"></section></div>`;
  S.selDate ||= S.me.today.date;
  await monthCalendar($('#cal'), { onPick: renderAdminDay });
  renderAdminDay(S.selDate);
}

async function renderAdminDay(date) {
  const box = $('#day');
  const d = await api(`/api/admin/day?date=${date}`);
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
  // уроки вне сетки (например, записанные вручную в нерабочее время)
  active.filter((b) => !covered.has('b' + b.id)).forEach((b) => rows.push({ t: b.start, kind: 'lesson', b }));
  rows.sort((a, b) => a.t.localeCompare(b.t));
  const history = d.bookings.filter((b) => ['cancelled', 'rejected'].includes(b.status));

  box.innerHTML = `
    <div class="card-head"><div><h2>${fmt(date)}</h2><div class="muted small">${d.window ? `${d.window.start}–${d.window.end}` : 'Выходной'}${d.override ? ' · изменён вручную' : ''}</div></div>
      <button class="btn ghost sm" id="dayCfg">Настроить день</button></div>
    <div class="timeline">${rows.length ? rows.map((r) => `<div class="tl-row"><div class="tl-time">${r.t}</div>${
      r.kind === 'lesson' ? `<button class="tl-item st-${r.b.status}" data-b="${r.b.id}"><div><div style="font-weight:700">${esc(r.b.name)}</div><div class="small muted">${r.b.start}–${r.b.end}${r.b.topic ? ' · ' + esc(r.b.topic) : ''}</div></div><span class="pill ${r.b.status}">${STATUS[r.b.status]}</span></button>`
      : r.kind === 'block' ? `<button class="tl-item block" data-bl="${r.bl.id}"><span>⛔ ${r.bl.start}–${r.bl.end} ${esc(r.bl.reason)}</span><span class="small">снять</span></button>`
      : r.s.past ? `<div class="tl-item free" style="opacity:.5;cursor:default"><span>${date < S.me.today.date || r.s.start < S.me.today.time ? 'прошло' : 'слишком скоро для записи'}</span></div>`
      : `<button class="tl-item free" data-free="${r.s.start}" data-end="${r.s.end}"><span>свободно</span><span class="small">＋</span></button>`
    }</div>`).join('') : '<div class="empty-state"><div>🌙</div>Нерабочий день</div>'}</div>
    ${history.length ? `<div class="muted small" style="margin-top:12px">Отменённые: ${history.map((b) => `${b.start} ${esc(b.name)}`).join(', ')}</div>` : ''}`;

  box.querySelector('#dayCfg').onclick = () => dayConfigSheet(date, d);
  box.querySelectorAll('[data-b]').forEach((el) => el.onclick = () => lessonSheet(d.bookings.find((b) => b.id == el.dataset.b), date));
  box.querySelectorAll('[data-bl]').forEach((el) => el.onclick = () =>
    run(() => api('/api/admin/block', { remove: el.dataset.bl }), 'Блокировка снята').then(() => refreshCal(date)));
  box.querySelectorAll('[data-free]').forEach((el) => el.onclick = () => freeSlotSheet(date, el.dataset.free, el.dataset.end));
}
async function refreshCal(date) {
  closeSheet();
  await monthCalendar($('#cal'), { onPick: renderAdminDay });
  renderAdminDay(date);
}

function lessonSheet(b, date) {
  const act = (status, label) => `<button class="btn ${status === 'done' || status === 'confirmed' ? 'ok' : status === 'cancelled' || status === 'no_show' || status === 'rejected' ? 'bad' : ''}" data-s="${status}">${label}</button>`;
  openSheet(`
    <h2>${esc(b.name)}</h2>
    <div class="muted">${fmt(b.date)}, ${b.start}–${b.end} · <span class="pill ${b.status}">${STATUS[b.status]}</span></div>
    <div class="actions">
      ${b.status === 'pending' ? act('confirmed', '✓ Подтвердить') + act('rejected', '✕ Отклонить') : ''}
      ${['pending', 'confirmed'].includes(b.status) ? act('done', '🎓 Проведён') + act('no_show', '🙈 Неявка') + act('cancelled', 'Отменить') + '<button class="btn" id="resch">🔁 Перенести</button>' : ''}
      ${['done', 'no_show', 'late_cancel'].includes(b.status) ? act('confirmed', '↩︎ Вернуть в план') : ''}
    </div>
    <div class="form">
      <div class="field"><label>Тема урока</label><input id="topic" value="${esc(b.topic)}" placeholder="Present Perfect, small talk…"></div>
      <div class="field"><label>Домашнее задание</label><textarea id="hw" placeholder="Workbook p.24 ex.1–3">${esc(b.homework)}</textarea></div>
      <div class="two"><button class="btn" id="saveN">Сохранить</button><button class="btn primary" id="sendN">Сохранить и отправить</button></div>
      <button class="btn ghost" id="openStu">👤 Карточка ученика</button>
    </div>`, (sh) => {
    sh.querySelectorAll('[data-s]').forEach((x) => x.onclick = () =>
      run(() => api('/api/admin/status', { id: b.id, status: x.dataset.s }), 'Статус обновлён').then(() => refreshCal(date)));
    const save = (notify) => run(() => api('/api/admin/notes', { id: b.id, topic: $('#topic').value, homework: $('#hw').value, notify }),
      notify ? 'ДЗ отправлено ученику' : 'Сохранено').then(() => refreshCal(date));
    $('#saveN').onclick = () => save(false);
    $('#sendN').onclick = () => save(true);
    $('#openStu').onclick = () => studentSheet(b.user_id);
    const r = $('#resch');
    if (r) r.onclick = () => pickSlotSheet('Перенести урок', async (nd, nt) => {
      await run(() => api('/api/admin/reschedule', { id: b.id, date: nd, start: nt }), 'Урок перенесён');
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
        <select id="stu">${students.map((s) => `<option value="${s.tg_id}">${esc(s.name)}</option>`).join('')}</select></div>
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
    const slots = (await api(`/api/slots?date=${date}`)).filter((s) => s.free);
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

// ---------- students ----------
async function adminStudents() {
  const list = await api('/api/admin/students');
  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Ученики · ${list.length}</h2></div>
      <input class="search" id="q" placeholder="Поиск по имени или @username">
      <div class="list" id="sl" style="margin-top:10px"></div>
    </section>`;
  const draw = (q = '') => {
    const f = list.filter((s) => `${s.name} ${s.username || ''}`.toLowerCase().includes(q.toLowerCase()));
    $('#sl').innerHTML = f.length ? f.map((s) => `
      <button class="item" data-u="${s.tg_id}">
        <div class="row" style="flex-wrap:nowrap;min-width:0"><div class="avatar">${initials(s.name)}</div>
          <div style="min-width:0"><div class="t">${esc(s.name)} ${s.blocked ? '🚫' : ''}</div>
          <div class="s">${esc(s.level || '—')} · ${esc(s.goal || '')} · уроков: ${s.lessons_done}${s.next_lesson ? ` · след.: ${fmt(s.next_lesson.slice(0, 10), { day: 'numeric', month: 'short' })} ${s.next_lesson.slice(11)}` : ''}</div></div></div>
        <span class="pill ${s.balance < 0 ? 'neg' : ''}">${s.balance} ур.</span>
      </button>`).join('') : '<div class="empty-state"><div>👋</div>Учеников пока нет — поделитесь ссылкой на бота</div>';
    view.querySelectorAll('[data-u]').forEach((b) => b.onclick = () => studentSheet(b.dataset.u));
  };
  $('#q').oninput = (e) => draw(e.target.value);
  draw();
}

async function studentSheet(id) {
  const d = await api(`/api/admin/student?id=${id}`);
  const u = d.user;
  openSheet(`
    <div class="row" style="flex-wrap:nowrap"><div class="avatar">${initials(u.name)}</div>
      <div><h2>${esc(u.name)}</h2><div class="muted small">${u.username ? '@' + esc(u.username) + ' · ' : ''}ID ${u.tg_id}</div></div></div>
    <div class="kpis" style="margin-top:12px">
      <div class="kpi"><span>Баланс</span><b class="${u.balance < 0 ? 'neg' : ''}">${u.balance}</b></div>
      <div class="kpi"><span>Проведено</span><b>${d.bookings.filter((b) => b.status === 'done').length}</b></div>
      <div class="kpi"><span>Отмены</span><b>${d.bookings.filter((b) => ['cancelled', 'late_cancel'].includes(b.status)).length}</b></div>
      <div class="kpi"><span>Оплачено, ₽</span><b>${d.payments.reduce((a, p) => a + p.amount, 0).toLocaleString('ru-RU')}</b></div>
    </div>
    <div class="form">
      <div class="two">
        <div class="field"><label>Уровень</label><input id="lv" value="${esc(u.level)}"></div>
        <div class="field"><label>Цель</label><input id="gl" value="${esc(u.goal)}"></div>
      </div>
      <div class="field"><label>Заметки</label><textarea id="nt">${esc(u.notes)}</textarea></div>
      <div class="two"><button class="btn" id="saveU">Сохранить</button><button class="btn ${u.blocked ? 'ok' : 'bad'}" id="blkU">${u.blocked ? 'Разблокировать' : 'Заблокировать'}</button></div>
      <h3>💳 Внести оплату</h3>
      <div class="two">
        <div class="field"><label>Сумма, ₽</label><input id="pa" type="number" inputmode="numeric" placeholder="6000"></div>
        <div class="field"><label>Уроков</label><input id="pl" type="number" inputmode="numeric" placeholder="4"></div>
      </div>
      <input class="search" id="pn" placeholder="Комментарий (пакет, способ оплаты…)">
      <button class="btn primary" id="payU">Добавить оплату</button>
      <button class="btn ghost" id="bookU">➕ Записать на урок</button>
    </div>
    <h3 style="margin-top:18px">Уроки</h3>
    <div class="list" style="margin-top:8px">${d.bookings.slice(0, 15).map((b) => `<div class="item" style="cursor:default"><div><div class="t">${fmt(b.date, { day: 'numeric', month: 'short' })}, ${b.start}${b.topic ? ' · ' + esc(b.topic) : ''}</div>${b.homework ? `<div class="s">📚 ${esc(b.homework)}</div>` : ''}</div><span class="pill ${b.status}">${STATUS[b.status]}</span></div>`).join('') || '<span class="muted small">Пока нет</span>'}</div>
    <h3 style="margin-top:18px">Журнал ученика</h3>
    <div class="log">${d.logs.slice(0, 15).map(logRow).join('') || '<span class="muted small">Пусто</span>'}</div>`, () => {
    $('#saveU').onclick = () => run(() => api('/api/admin/student', { tg_id: u.tg_id, level: $('#lv').value, goal: $('#gl').value, notes: $('#nt').value }), 'Сохранено');
    $('#blkU').onclick = () => run(() => api('/api/admin/student', { tg_id: u.tg_id, blocked: u.blocked ? 0 : 1 }), 'Готово').then(() => studentSheet(id));
    $('#payU').onclick = () => {
      if (!$('#pa').value) return toast('Укажите сумму');
      run(() => api('/api/admin/payment', { user_id: u.tg_id, amount: $('#pa').value, lessons: $('#pl').value || 0, note: $('#pn').value }), 'Оплата записана').then(() => studentSheet(id));
    };
    $('#bookU').onclick = () => pickSlotSheet(`Записать: ${esc(u.name)}`, async (date, start) => {
      await run(() => api('/api/admin/book', { user_id: u.tg_id, date, start }), 'Ученик записан');
      studentSheet(id);
    });
  });
}

// ---------- log ----------
function logRow(l) {
  const ts = new Intl.DateTimeFormat('ru-RU', { timeZone: S.me.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date(l.ts.replace(' ', 'T') + 'Z')).replace(',', '');
  const det = Object.entries(l.details || {}).filter(([k]) => !['booking_id', 'user_id'].includes(k))
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
  return `<div class="log-row"><time>${ts}</time>
    <div><b>${ACTIONS[l.action] || l.action}</b> ${l.name ? `· ${esc(l.name)}` : l.actor_id ? '' : '· система'}
    ${det ? `<div class="muted small">${esc(det)}</div>` : ''}</div></div>`;
}
async function adminLog() {
  const logs = await api('/api/admin/logs?limit=400');
  const groups = [...new Set(logs.map((l) => l.action.split('.')[0]))];
  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Журнал действий</h2><span class="muted small">${logs.length} записей</span></div>
      <div class="row" id="flt" style="margin-bottom:8px"><button class="btn sm primary" data-f="">Все</button>
        ${groups.map((g) => `<button class="btn sm" data-f="${g}">${{ booking: 'Уроки', payment: 'Оплаты', user: 'Ученики', settings: 'Настройки', day: 'Дни', block: 'Блоки', reminder: 'Напоминания', system: 'Система', broadcast: 'Рассылки', message: 'Сообщения', export: 'Экспорт' }[g] || g}</button>`).join('')}</div>
      <div class="log" id="lg"></div>
    </section>`;
  const draw = (f) => { $('#lg').innerHTML = logs.filter((l) => !f || l.action.startsWith(f + '.') || l.action === f).map(logRow).join('') || '<div class="empty-state">Пусто</div>'; };
  view.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => {
    view.querySelectorAll('[data-f]').forEach((x) => x.classList.remove('primary'));
    b.classList.add('primary');
    draw(b.dataset.f);
  });
  draw('');
}

// ---------- settings ----------
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
          <div class="field"><label>Цена урока, ₽</label><input type="number" name="price" value="${s.price}"></div>
          <div class="field"><label>Запись на N дней вперёд</label><input type="number" name="days_ahead" value="${s.days_ahead}" min="1"></div>
        </div>
        <div class="two">
          <div class="field"><label>Бесплатная отмена за, ч</label><input type="number" name="cancel_hours" value="${s.cancel_hours}" min="0"></div>
          <div class="field"><label>Бронь не позже чем за, ч</label><input type="number" name="min_hours_before" value="${s.min_hours_before}" min="0"></div>
        </div>
        <div class="field"><label>Максимум запланированных уроков у ученика</label><input type="number" name="max_active" value="${s.max_active}" min="1"></div>
        <div class="field"><label>Подтверждение броней</label>
          <select name="auto_confirm"><option value="0" ${s.auto_confirm === '0' ? 'selected' : ''}>Вручную — я подтверждаю каждую</option><option value="1" ${s.auto_confirm === '1' ? 'selected' : ''}>Автоматически</option></select></div>
        <div class="field"><label>Правила для учеников</label><textarea name="rules">${esc(s.rules)}</textarea></div>
        <button class="btn primary" type="submit">Сохранить настройки</button>
      </form>
    </section>
    <section class="card">
      <div class="card-head"><h2>Экспорт данных (CSV для Excel)</h2></div>
      <div class="row">${[['bookings', 'Уроки'], ['students', 'Ученики'], ['payments', 'Оплаты'], ['logs', 'Журнал']].map(([k, l]) => `<button class="btn ghost sm" data-exp="${k}">${l}</button>`).join('')}</div>
      <div class="muted small" style="margin-top:8px">Файл придёт вам в чат с ботом.</div>
    </section>`;
  view.querySelectorAll('[data-exp]').forEach((b) => b.onclick = () =>
    run(() => api('/api/admin/export-to-chat', { kind: b.dataset.exp }), '📤 Файл отправлен в чат с ботом'));
  $('#sf').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries([...fd.entries()].filter(([k]) => k !== 'wd'));
    body.work_days = fd.getAll('wd').join(',');
    run(() => api('/api/admin/settings', body), 'Настройки сохранены').then((r) => { S.settings = r; });
  };
}

// =====================================================================
// router
// =====================================================================
const RENDER = { book: studentBook, my: studentMy, dash: adminDash, cal: adminCal, students: adminStudents, log: adminLog, settings: adminSettings };
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
  S.month = S.me.today.date.slice(0, 7);
  const admin = S.me.admin;
  $('#hello').textContent = admin ? 'Панель преподавателя' : `Преподаватель — ${S.me.settings.teacher_name}`;
  $('#title').textContent = admin ? S.me.settings.teacher_name : 'Уроки английского';
  $('#badge').textContent = admin ? '🛠 Админ' : `💳 ${S.me.user.balance} ур.`;
  const tabs = admin ? adminTabs : studentTabs;
  $('#tabs').innerHTML = tabs.map((t) => `<button data-tab="${t.id}"><span>${t.icon}</span>${t.label}</button>`).join('');
  $('#tabs').querySelectorAll('button').forEach((b) => b.onclick = () => { haptic(); go(b.dataset.tab); });
  if (admin) api('/api/admin/settings').then((s) => { S.settings = s; }).catch(() => {});
  go(tabs[0].id);
})();
