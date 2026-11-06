import { spawn } from 'node:child_process';
import { config } from './config.js';
import { createBot } from './bot.js';
import { startWeb } from './web.js';
import { log } from './db.js';

if (!config.botToken && !config.devMode) {
  console.error('❌ Не задан BOT_TOKEN. Скопируйте .env.example в .env и заполните его.');
  process.exit(1);
}

/**
 * Запускает туннель Cloudflare к локальному API и возвращает его https-адрес.
 * Сервер не открыт в интернет напрямую: весь трафик идёт через сеть Cloudflare
 * (скрывает IP и поглощает DDoS). При падении туннель перезапускается.
 */
function startTunnel(onUrl) {
  const run = () => {
    const p = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${config.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let found = false;
    const scan = (buf) => {
      const m = !found && String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { found = true; onUrl(m[0]); }
    };
    p.stdout.on('data', scan);
    p.stderr.on('data', scan);
    p.on('exit', (code) => {
      console.error(`⚠️ Туннель остановился (код ${code}), перезапуск через 5 с…`);
      log(null, 'system.tunnel_restart', { code });
      setTimeout(run, 5000);
    });
    process.once('exit', () => p.kill());
  };
  run();
}

if (config.botToken) {
  const { bot, notifyUser, notifyAdmins, sendFile, startReminders } = createBot();
  startWeb({ notifyUser, notifyAdmins, sendFile });

  await bot.api.setMyCommands([
    { command: 'start', description: 'Главное меню' },
    { command: 'book', description: 'Записаться на урок' },
    { command: 'id', description: 'Мой Telegram ID' },
  ]);

  const applyWebApp = async () => {
    if (!config.webAppUrl) return;
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Календарь', web_app: { url: config.webAppUrl } } });
    console.log(`📱 Мини-приложение: ${config.webAppUrl}`);
  };

  if (config.tunnel && config.pagesUrl) {
    startTunnel(async (apiUrl) => {
      config.webAppUrl = `${config.pagesUrl}/?api=${encodeURIComponent(apiUrl)}`;
      log(null, 'system.tunnel', { api: apiUrl });
      await applyWebApp().catch((e) => console.error('menu button', e.message));
    });
  } else {
    await applyWebApp();
  }

  startReminders();
  log(null, 'system.start', {});
  bot.start({
    drop_pending_updates: false,
    onStart: (me) => console.log(`🤖 Бот @${me.username} запущен. Админы: ${config.adminIds.join(', ') || '— (укажите ADMIN_IDS)'}`),
  });
  process.once('SIGINT', () => { bot.stop(); process.exit(0); });
  process.once('SIGTERM', () => { bot.stop(); process.exit(0); });
} else {
  // DEV без токена: только мини-приложение (уведомления пишутся в консоль)
  const noop = async (...a) => console.log('[notify]', ...a.slice(0, 2));
  startWeb({ notifyUser: noop, notifyAdmins: noop });
}
