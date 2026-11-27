#!/usr/bin/env node
/* =============================================================================
   WORMS-АРЕНА (public/island/worms.html), набор WRM.

   Появился 27.11.2026 после слов владельца: "микрофон должен был сам быть активным
   без всяких кнопок" и "сделай на веб размером с телефон". До этого дня страницу
   не проверял ни один набор: на ней оставалась кнопка "Держи и говори", а без
   доступа к микрофону подпись "Говорю…" залипала и ход не кончался никогда.

   Сценарии:
     WRM-0x  настоящая речь через поддельный микрофон Chromium и БОЕВОЕ распознавание:
             ни одного клика - шкала двигается, банан заряжается сам, рогатка стреляет,
             на следующем ходу игра снова слушает сама
     WRM-1x  микрофон запрещён: игра говорит словами, тап по фразе заряжает
     WRM-2x  тишина: на сервер не уходит ни одного запроса, после двух кругов - тап
     WRM-3x  сказал не то: одна бесплатная попытка, потом кривой заряд
     WRM-4x  кнопка "послушать": пока игра говорит, микрофон молчит, потом слушает сам
     WRM-5x  телефонный формат на окнах 390x844, 766x600, 1280x800

   Запуск: node qa/run-worms.mjs [--base=https://english-kombat.vercel.app] [--shots=папка]
   ⚠️ Сценарий WRM-0x ходит в боевой /api/island/transcribe (один-два запроса).
   ============================================================================= */
import { loadPlaywright, pickExecutable, startServer, scenario, check, report, API_HOST } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const BASE = arg('base'), SHOTS = arg('shots'), PAGE = arg('page') || 'island/worms.html';
const AUDIO = path.join(__dirname, 'audio', 'p1_pause.wav');     // "One board please" + 2.5 с тишины
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let ORIGIN = BASE, browser = null;

function initDenied() {
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () =>
    Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
}
function initSilentMic() {   // микрофон есть, но в нём тишина
  navigator.mediaDevices.getUserMedia = async () => {
    const ac = new AudioContext(); const dst = ac.createMediaStreamDestination();
    const g = ac.createGain(); g.gain.value = 0; const o = ac.createOscillator(); o.connect(g); g.connect(dst); o.start();
    return dst.stream;
  };
}
function initTts() {
  window.__tts = [];
  const stub = { speak(u) { window.__tts.push(u.text); setTimeout(() => { try { u.onend && u.onend({}); } catch (e) {} }, 300); },
    cancel() {}, pause() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => stub });
}

async function open({ viewport = { width: 390, height: 844 }, mic = 'file', transcript = null } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (mic !== 'denied') await ctx.grantPermissions(['microphone'], { origin: ORIGIN }).catch(() => {});
  await ctx.addInitScript(initTts);
  if (mic === 'denied') await ctx.addInitScript(initDenied);
  if (mic === 'silent') await ctx.addInitScript(initSilentMic);
  const calls = { transcribe: 0 };
  await ctx.route(`${API_HOST}/**`, async route => {
    const u = route.request().url();
    if (u.includes('/api/island/content')) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: { battle: [{ ru: 'Одну доску, пожалуйста', en: 'One board, please', ans: ['one board please', 'one board'] }] } }) });
    if (u.includes('/api/island/transcribe')) {
      calls.transcribe++;
      if (transcript === null) return route.continue();              // боевое распознавание
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ transcript, confidence: 0.9 }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const page = await ctx.newPage();
  page.errors = []; page.calls = calls; page.ctx = ctx;
  page.on('pageerror', e => page.errors.push(String(e && e.message || e)));
  await page.goto(`${ORIGIN}/${PAGE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mBot', { timeout: 15000 });
  await page.waitForTimeout(700);                                    // фразы с сервера (подменены) успевают прийти
  return page;
}
const startBot = async page => { await page.click('#mBot'); await page.waitForFunction(() => typeof SCENE !== 'undefined' && SCENE && SCENE.turn === 'me', null, { timeout: 15000 }); };
const info = page => page.evaluate(() => ({
  turn: SCENE.turn, charged: SCENE.charged, miss: !!SCENE.missKick, busy: SCENE.busy,
  heard: document.getElementById('spHeard').textContent, card: document.getElementById('speech').style.display !== 'none',
  hint: SCENE.ui.hint.visible ? SCENE.ui.hint.text : '', phrase: document.getElementById('spEn').textContent,
  buttons: [...document.querySelectorAll('#speech button')].filter(b => b.offsetHeight > 0).map(b => b.textContent.trim()),
  hasHold: !!document.getElementById('spMic') || /Держи|Зажми/i.test(document.getElementById('speech').innerText),
  tap: !!document.getElementById('spPhrase') && document.getElementById('spPhrase').classList.contains('tap')
}));
const waitHeard = (page, rx, timeout = 15000) => page.waitForFunction(r => new RegExp(r).test(document.getElementById('spHeard').textContent), rx.source, { timeout }).then(() => true).catch(() => false);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
// рогатка: тянем назад-вниз от бойца, отпускаем
async function sling(page) {
  const p = await page.evaluate(() => { const c = document.querySelector('#game canvas').getBoundingClientRect(); const k = c.width / CFG.W;
    return { x: c.left + SCENE.myWorm.x * k, y: c.top + SCENE.myWorm.y * k, k }; });
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x - 170 * p.k, p.y + 120 * p.k, { steps: 6 }); await page.mouse.up();
}
function measureCard() {
  const app = document.getElementById('app').getBoundingClientRect();
  const card = document.getElementById('speech').getBoundingClientRect();
  const ids = ['spRu', 'spEn', 'spEq', 'spHeard', 'spSay'];
  const b = ids.map(id => ({ id, r: document.getElementById(id).getBoundingClientRect() })).filter(x => x.r.height > 0);
  const over = []; let pairs = 0;
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) { pairs++;
    const v = Math.min(b[i].r.bottom, b[j].r.bottom) - Math.max(b[i].r.top, b[j].r.top), h = Math.min(b[i].r.right, b[j].r.right) - Math.max(b[i].r.left, b[j].r.left);
    if (v > 1 && h > 1) over.push(b[i].id + '×' + b[j].id); }
  const out = b.filter(x => x.r.left < card.left - 1 || x.r.right > card.right + 1 || x.r.bottom > card.bottom + 1).map(x => x.id);
  const back = document.querySelector('.back-link').getBoundingClientRect();
  const cv = document.querySelector('#game canvas').getBoundingClientRect();
  return { appW: Math.round(app.width), appH: Math.round(app.height), ratio: +(app.height / app.width).toFixed(2), pairs, over, out,
    cardIn: card.left >= app.left - 1 && card.right <= app.right + 1 && card.bottom <= app.bottom + 1,
    backIn: back.left >= app.left && back.right <= app.right && back.left >= 0,
    wormsClear: [SCENE.myWorm, SCENE.foeWorm].every(wm => cv.top + (wm.y + 30) * (cv.height / CFG.H) <= card.top + 2),
    canvasIn: cv.left >= app.left - 1 && cv.right <= app.right + 1, canvasW: Math.round(cv.width), fieldPortrait: CFG.H > CFG.W, win: [innerWidth, innerHeight] };
}

(async () => {
  let srv = null;
  if (!BASE) { const s = await startServer(); srv = s.srv; ORIGIN = `http://127.0.0.1:${s.port}`; }
  console.log(`Worms-арена: ${ORIGIN}/${PAGE}`);
  const pw = loadPlaywright();
  browser = await pw.chromium.launch({ headless: true, executablePath: pickExecutable(false) || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + AUDIO,
           '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
           // стенд детерминирован: headless иногда считает страницу фоновой и душит таймеры до 1 раза в секунду
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  try {
    { scenario('Настоящая речь, боевое распознавание, ни одного клика по записи');
      const page = await open({});
      await startBot(page);
      const a = await info(page);
      check('WRM-01', 'На своём ходу нет кнопки записи "Держи и говори"', !a.hasHold, JSON.stringify(a.buttons));
      check('WRM-02', 'Игра сама слушает и говорит об этом словами', a.card && /Слушаю/.test(a.heard), a.heard);
      let maxH = 0; for (let i = 0; i < 40 && maxH <= 8; i++) { maxH = Math.max(maxH, ...(await page.evaluate(() => [...document.querySelectorAll('#spEq i')].map(b => parseFloat(b.style.height) || 0)))); await page.waitForTimeout(100); }
      check('WRM-03', `Шкала голоса двигается от речи (максимум ${maxH.toFixed(1)}px, покой 4px)`, maxH > 8);
      await shot(page, 'worms-390-listening');
      const ok = await waitHeard(page, /заряжено/, 25000);
      const heard = (await info(page)).heard;
      await page.waitForFunction(() => SCENE.charged, null, { timeout: 4000 }).catch(() => {});
      const b = await info(page);
      check('WRM-04', `Фраза распознана и банан заряжен без единого касания: ${heard}`, ok && b.charged && !b.miss, JSON.stringify(b));
      check('WRM-05', 'После заряда карточка убрана и показана подсказка про рогатку', !b.card && /рогатк/.test(b.hint), JSON.stringify({ card: b.card, hint: b.hint }));
      await sling(page);
      const fired = await page.waitForFunction(() => SCENE.busy || SCENE.turn !== 'me', null, { timeout: 4000 }).then(() => true).catch(() => false);
      check('WRM-06', 'Рогатка стреляет заряженным бананом', fired);
      const again = await page.waitForFunction(() => SCENE.turn === 'me' && !SCENE.busy && /Слушаю/.test(document.getElementById('spHeard').textContent), null, { timeout: 40000 }).then(() => true).catch(() => false);
      const c = await page.evaluate(() => SCENE.turn);
      check('WRM-07', 'На следующем своём ходу игра снова слушает сама', again || c === 'over', `ход: ${c}`);
      check('WRM-08', 'Нет ошибок скрипта', page.errors.length === 0, page.errors.join(' | '));
      await page.ctx.close(); }

    { scenario('Микрофон запрещён средой');
      const page = await open({ mic: 'denied', viewport: { width: 766, height: 600 } });
      await startBot(page);
      const told = await waitHeard(page, /тапни по фразе/, 8000);
      const a = await info(page);
      check('WRM-10', 'Игра словами говорит, что микрофона нет, и зовёт тапнуть по фразе', told && /икрофон/.test(a.heard), a.heard);
      check('WRM-11', 'Подпись "Говорю…" не залипает', !/Говорю/.test(a.heard), a.heard);
      await shot(page, 'worms-766-denied');
      await page.click('#spPhrase');
      await page.waitForFunction(() => SCENE.charged, null, { timeout: 4000 }).catch(() => {});
      const b = await info(page);
      check('WRM-12', 'Тап по фразе заряжает банан', b.charged && !b.miss, JSON.stringify(b));
      await sling(page);
      check('WRM-13', 'И банан летит', await page.waitForFunction(() => SCENE.busy || SCENE.turn !== 'me', null, { timeout: 4000 }).then(() => true).catch(() => false));
      await page.ctx.close(); }

    { scenario('Микрофон есть, но игрок молчит');
      const page = await open({ mic: 'silent', transcript: 'should not be called' });
      await startBot(page);
      const told = await waitHeard(page, /Не слышу/, 12000);
      const tap = await page.waitForFunction(() => document.getElementById('spPhrase').classList.contains('tap'), null, { timeout: 12000 }).then(() => true).catch(() => false);
      const a = await info(page);
      check('WRM-20', 'На тишину игра отвечает "не слышу тебя" и продолжает слушать', told && a.card && !a.charged, a.heard);
      check('WRM-21', `Тишина не уходит на сервер: запросов распознавания ${page.calls.transcribe}`, page.calls.transcribe === 0);
      check('WRM-22', 'После двух кругов тишины можно тапнуть по фразе', tap, a.heard);
      await page.click('#spPhrase'); await page.waitForFunction(() => SCENE.charged, null, { timeout: 4000 }).catch(() => {});
      check('WRM-23', 'Тап заряжает', (await info(page)).charged);
      await page.ctx.close(); }

    { scenario('Сказал не то');
      const page = await open({ transcript: 'banana potato' });
      await startBot(page);
      const retry = await waitHeard(page, /ещё раз/, 20000);
      check('WRM-30', 'Первая неверная фраза - бесплатная попытка "ещё раз"', retry && !(await info(page)).charged, (await info(page)).heard);
      const crooked = await page.waitForFunction(() => SCENE.charged && SCENE.missKick, null, { timeout: 25000 }).then(() => true).catch(() => false);
      const b = await info(page);
      check('WRM-31', 'Вторая неверная - кривой заряд, ход не встаёт', crooked && /Крив/.test(b.hint), b.heard + ' | детектор: ' + JSON.stringify(await page.evaluate(() => window.__vadLog)));
      check('WRM-32', 'Игра вслух произносит верную фразу', (await page.evaluate(() => window.__tts)).includes('One board, please'));
      await page.ctx.close(); }

    { scenario('Кнопка "послушать"');
      const page = await open({ mic: 'silent', transcript: '' });
      await startBot(page);
      await waitHeard(page, /Слушаю/, 5000);
      // подпись читаем в том же тике, что и клик: подменённый синтез заканчивает фразу за 300 мс
      const a = await page.evaluate(() => { document.getElementById('spSay').click(); return { heard: document.getElementById('spHeard').textContent }; });
      const back = await waitHeard(page, /Слушаю/, 6000);
      check('WRM-40', 'Пока игра произносит фразу, она не слушает; потом слушает сама', /Слушай/.test(a.heard) && back, `во время: "${a.heard}"`);
      check('WRM-41', 'Фраза произнесена', (await page.evaluate(() => window.__tts)).includes('One board, please'));
      await page.ctx.close(); }

    for (const [w, h] of [[390, 844], [766, 600], [1280, 800]]) {
      scenario(`Телефонный формат, окно ${w}x${h}`);
      const page = await open({ mic: 'denied', viewport: { width: w, height: h } });
      await startBot(page);
      await waitHeard(page, /тапни/, 8000);
      await page.waitForTimeout(400);
      const m = await page.evaluate(measureCard);
      check(`WRM-5${w}-1`, `Игра в колонке шириной с телефон: ${m.appW}x${m.appH} при окне ${w}x${h}`, m.appW <= 520 && m.appW <= w && m.ratio >= 1.5, JSON.stringify(m));
      check(`WRM-5${w}-2`, 'Поле портретное, канвас, карточка фразы и кнопка "назад" внутри колонки', m.fieldPortrait && m.canvasIn && m.cardIn && m.backIn, JSON.stringify(m));
      check(`WRM-5${w}-3`, `Строки карточки не наезжают и не вылезают: пар ${m.pairs}, наложений ${m.over.length}, за краем ${m.out.length}`, !m.over.length && !m.out.length, m.over.concat(m.out).join(','));
      check(`WRM-5${w}-4`, 'Карточка фразы не закрывает бойцов', m.wormsClear, JSON.stringify({ win: m.win, app: [m.appW, m.appH] }));
      await shot(page, `worms-${w}x${h}`);
      await page.ctx.close();
    }
  } catch (e) { check('WRM-00', 'Прогон дошёл до конца', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' / ')); }
  await browser.close(); if (srv) srv.close();
  process.exit(report(BASE ? 'last-run-worms-live.json' : 'last-run-worms.json') ? 1 : 0);
})();
