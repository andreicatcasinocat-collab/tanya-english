// Демо-данные для просмотра панели без Telegram: npm run demo
import * as D from '../src/db.js';

const names = [
  ['Анна Смирнова', 'B1', 'Разговорный'], ['Игорь Петров', 'A2', 'Для работы'], ['Мария Ким', 'B2', 'IELTS / TOEFL'],
  ['Дмитрий Орлов', 'A1', 'Путешествия'], ['Ольга Белова', 'C1', 'Для работы'], ['Саша Ли', 'B1', 'Школа / ВУЗ'],
];

names.forEach(([name, level, goal], i) => {
  const id = 1000 + i;
  D.upsertUser({ id, first_name: name, username: `student${i + 1}` });
  D.updateUser(id, { name, level, goal, registered: 1 }, id);
  D.addPayment(id, 6000, 4, 'пакет 4 урока', 1);
});
const today = D.nowLocal().date;
let k = 0;
for (let off = -12; off <= 14; off++) {
  const date = D.addDays(today, off);
  const slots = D.slotsFor(date).map((s) => s.start);
  if (!slots.length) continue;
  const n = Math.min(slots.length, [2, 5, 8, 3, 10, 6, 1, 7, 4, 9][(off + 30) % 10]);
  for (let j = 0; j < n; j++) {
    const uid = 1000 + (k++ % names.length);
    const start = slots[(j * 2 + off + 20) % slots.length];
    try {
      const b = D.createBooking({ userId: uid, date, start, actorId: uid, force: true });
      if (off < 0) D.setBookingStatus(b.id, k % 9 === 0 ? 'no_show' : 'done', 1);
      else if (k % 9 === 0) D.setBookingStatus(b.id, 'pending', uid);
      if (off < 0) D.updateBookingNotes(b.id, { topic: 'Past Simple vs Present Perfect', homework: 'Workbook p.24, ex. 1–3' }, 1);
    } catch {}
  }
}
D.addBlock(D.addDays(today, 1), '13:00', '15:00', 'Обед / личное', 1);
console.log('Демо-данные созданы');
