/* Живой прогон воронки онбординга ПРЯМО ПО ПРОДАКШЕНУ.
   Локальные наборы (run-funnel/run-edge/...) поднимают свой сервер из public/
   и подменяют боевой API заглушками. Этот набор бьёт по настоящему домену
   и настоящему бэкенду - подтверждает, что задеплоенное работает у живого игрока.

   Отличие от стенда: на живом кружок Романа озвучивается реальным TTS, поэтому
   шаг «посмотреть кружок» идёт секундами, а не мгновенно. Ждём либо следующего
   шага, либо запасного чипа «Дальше 👉» (он появляется через 14 секунд).

   Запуск: node qa/run-live.mjs [--base=https://english-kombat.vercel.app] [--headed]
*/
import { loadPlaywright, pickExecutable } from './harness.mjs';

const ARGS = process.argv.slice(2);
const BASE = (ARGS.find(a => a.startsWith('--base=')) || '').split('=')[1]
  || 'https://english-kombat.vercel.app';
const HEADED = ARGS.includes('--headed');

// верные индексы дефолтного теста (content-defaults.js)
const CORRECT = [1, 1, 0, 1, 1, 1];
const pickFor = flags => CORRECT.map((c, i) => (flags[i] ? c : (c + 1) % 3));

const results = [];
const check = (id, title, pass, detail = '') => {
  results.push({ id, title, pass, detail });
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${id}  ${title}${detail ? '  ' + detail : ''}`);
};

const chips = page => page.$$('#onbQuick .chip:not(.hidden)');
const quickVisible = page => page.evaluate(() =>
  !document.querySelector('#onbQuick')?.classList.contains('hidden')
  && document.querySelectorAll('#onbQuick .chip').length > 0);

/* Пройти кружок: кликнуть по нему и дождаться, пока воронка уедет дальше.
   Живой кружок озвучивается TTS - ждём до 25 с; если появился запасной
   чип «Дальше 👉», жмём его (ровно так же поступит живой игрок). */
async function passCircleLive(page, nth) {
  await page.waitForFunction(n => document.querySelectorAll('#chatScroll .vcircle').length >= n,
    nth, { timeout: 25000 });
  const list = await page.$$('#chatScroll .vcircle');
  await list[list.length - 1].click();
  await page.waitForFunction(() => {
    const q = document.querySelector('#onbQuick');
    const shown = q && !q.classList.contains('hidden') && q.querySelectorAll('.chip').length;
    const inputAsks = /Как тебя зовут|зовут\?/i.test(document.querySelector('#chatScroll')?.innerText || '');
    return shown || inputAsks;
  }, null, { timeout: 30000 });
  // запасной чип «Дальше 👉» - если озвучка не досказала, игрок жмёт его
  for (const c of await chips(page)) {
    if (/Дальше/.test((await c.textContent() || '').trim())) { await c.click(); break; }
  }
}

async function pickChip(page, idx) {
  await page.waitForFunction(() => {
    const q = document.querySelector('#onbQuick');
    return q && !q.classList.contains('hidden') && q.querySelectorAll('.chip').length > 0;
  }, null, { timeout: 25000 });
  const list = await chips(page);
  await list[Math.min(idx, list.length - 1)].click();
}

async function walkLive(page, { name, picks }) {
  await passCircleLive(page, 1);                               // кружок 1
  await page.waitForFunction(() => /зовут/i.test(document.querySelector('#chatScroll')?.innerText || ''),
    null, { timeout: 20000 });
  await page.fill('#onbInput', name);
  await page.press('#onbInput', 'Enter');
  await pickChip(page, 0);                                     // цель
  await pickChip(page, 0);                                     // время в день
  await passCircleLive(page, 2);                               // кружок 2
  await pickChip(page, 0);                                     // опыт
  await passCircleLive(page, 3);                               // кружок 3
  for (let i = 0; i < picks.length; i++) {
    await page.waitForFunction(n => new RegExp('Вопрос ' + n + ' из').test(document.querySelector('#chatScroll')?.innerText || ''),
      i + 1, { timeout: 25000 });
    await pickChip(page, picks[i]);
  }
  await page.waitForSelector('#bigStart', { timeout: 25000 });
}

async function branch(browser, { tag, name, flags, expTrack, expLevel }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const sent = [];
  page.on('request', r => {
    if (r.url().includes('/api/island/quiz-result')) {
      try { sent.push(JSON.parse(r.postData() || '{}')); } catch { sent.push({}); }
    }
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(`${BASE}/island/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s-perm.on', { timeout: 12000 }).catch(() => {});
  await page.click('#permSkip').catch(() => {});

  let walkErr = null;
  try { await walkLive(page, { name, picks: pickFor(flags) }); } catch (e) { walkErr = e.message; }

  // состояние игрока живёт в localStorage (тот же ключ, что читает сама игра)
  const st = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('ek_island_v1') || '{}'); } catch { return {}; }
  });
  check(`${tag}-01`, 'Воронка дошла до кнопки START', !walkErr && !!(await page.$('#bigStart')), walkErr || '');
  check(`${tag}-02`, `Маршрут = ${expTrack}`, st.track === expTrack, `S.track=${st.track}`);
  check(`${tag}-03`, `Уровень = ${expLevel}`, st.level === expLevel, `S.level=${st.level}`);
  check(`${tag}-04`, 'Имя сохранено', st.name === name, `S.name=${st.name}`);
  check(`${tag}-05`, 'Результат теста ушёл на живой сервер', sent.length === 1, `отправок: ${sent.length}`);
  check(`${tag}-06`, 'На сервер ушёл тот же маршрут',
    (sent[0]?.track || sent[0]?.level) === expTrack, `payload=${sent[0]?.track ?? sent[0]?.level}`);
  check(`${tag}-07`, 'Нет исключений на странице', errors.length === 0, errors[0] || '');

  await ctx.close();
}

(async () => {
  console.log(`\x1b[1mЖивой прогон Острова\x1b[0m  ${BASE}\n`);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: !HEADED,
    executablePath: pickExecutable(HEADED) || undefined
  });
  try {
    console.log('\x1b[36m▶ Ветка Basic (все ответы мимо)\x1b[0m');
    await branch(browser, { tag: 'LIVE-B', name: 'ЖивойBasic', flags: [0, 0, 0, 0, 0, 0], expTrack: 'basic', expLevel: 'beginner' });
    console.log('\n\x1b[36m▶ Ветка Advanced (все ответы верные)\x1b[0m');
    await branch(browser, { tag: 'LIVE-A', name: 'ЖивойAdv', flags: [1, 1, 1, 1, 1, 1], expTrack: 'advanced', expLevel: 'advanced' });
  } finally {
    await browser.close();
  }
  const bad = results.filter(r => !r.pass);
  console.log('\n' + '─'.repeat(64));
  console.log(`Проверок: ${results.length}   ${bad.length ? '\x1b[31m' : '\x1b[32m'}прошло ${results.length - bad.length}\x1b[0m   упало ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})();
