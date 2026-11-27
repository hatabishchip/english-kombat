#!/usr/bin/env node
/* =============================================================================
   ДУЭЛЬ 90 СЕКУНД (экран s-duel Острова), набор DUE.

   Появился 27.11.2026. Владелец сказал про бой: "микрофон должен был сам быть
   активным без всяких кнопок". Бой и локации шли без кнопок с 12.08, а в дуэли
   оставалась "Держи и говори (англ.)", и ни один набор дуэль не открывал.

   Сценарии:
     DUE-0x  настоящая речь через поддельный микрофон: ни одного касания - шкала
             двигается, ответ сам уходит судье, счёт растёт, раунд 2 снова слушает
     DUE-1x  микрофон запрещён: игра говорит об этом словами и даёт написать ответ
     DUE-2x  тишина: на сервер ничего не уходит, 0:0 по таймеру - не победа
     DUE-3x  блок слушания и поле ввода помещаются на окнах 390x844 и 766x600

   Запуск: node qa/run-duel.mjs [--base=https://english-kombat.vercel.app]
   Распознавание и судья подменены: в боевую базу и в Deepgram ничего не уходит.
   ============================================================================= */
import { loadPlaywright, pickExecutable, startServer, scenario, check, report, newPage, walkFunnel, API_HOST } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv.find(a => a.startsWith('--base=')) || '').split('=').slice(1).join('=');
const AUDIO = path.join(__dirname, 'audio', 'p1_pause.wav');     // "One board please" + 2.5 с тишины
const SHOTS = (process.argv.find(a => a.startsWith('--shots=')) || '').split('=').slice(1).join('=');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

function initDenied() {
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () =>
    Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
}
function initSilentMic() {
  navigator.mediaDevices.getUserMedia = async () => {
    const ac = new AudioContext(); const dst = ac.createMediaStreamDestination();
    const g = ac.createGain(); g.gain.value = 0; const o = ac.createOscillator(); o.connect(g); g.connect(dst); o.start();
    return dst.stream;
  };
}

(async () => {
  let srv = null, origin = BASE;
  if (!BASE) { const s = await startServer(); srv = s.srv; origin = `http://127.0.0.1:${s.port}`; }
  console.log(`Дуэль Острова: ${origin}/island`);
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true, executablePath: pickExecutable(false) || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + AUDIO,
           '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });

  // до дуэли: знакомство -> карта -> кнопка дуэли
  async function openDuel({ mic = 'file', viewport = { width: 390, height: 844 }, transcript = 'One board please' } = {}) {
    const page = await newPage(browser, { viewport });
    const calls = { transcribe: 0, judge: [] }; page.calls = calls;
    if (mic === 'denied') await page.ctx.addInitScript(initDenied);
    else await page.ctx.grantPermissions(['microphone'], { origin }).catch(() => {});
    if (mic === 'silent') await page.ctx.addInitScript(initSilentMic);
    await page.ctx.route(`${API_HOST}/api/island/transcribe**`, route => { calls.transcribe++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ transcript, confidence: 0.93 }) }); });
    await page.ctx.route(`${API_HOST}/api/island/judge**`, route => {
      try { calls.judge.push(JSON.parse(route.request().postData() || '{}')); } catch { calls.judge.push(null); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ score: 70, verdict: 'Засчитано!', better: 'I would like one board, please.' }) }); });
    await page.goto(`${origin}/island`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#s-perm.on', { timeout: 15000 });
    await page.click('#permSkip');
    await walkFunnel(page, { name: 'Дуэлянт' });
    await page.click('#bigStart');
    await page.waitForSelector('#s-map.on', { timeout: 15000 });
    await page.click('#floatDuel');
    await page.waitForSelector('#s-duel.on', { timeout: 8000 });
    return page;
  }
  const info = page => page.evaluate(() => ({
    heard: (document.getElementById('duelHeard') || {}).textContent || '',
    hold: !!document.getElementById('duelMic') || /Держи|Зажми/i.test(document.getElementById('s-duel').innerText),
    buttons: [...document.querySelectorAll('#s-duel button')].filter(b => b.offsetHeight > 0).map(b => b.textContent.trim()),
    typeOn: !!document.getElementById('duelType') && document.getElementById('duelType').offsetHeight > 0,
    you: +document.getElementById('duelYou').textContent, ai: +document.getElementById('duelAi').textContent,
    round: document.getElementById('duelRound').textContent, timer: +document.getElementById('duelTimer').textContent,
    fb: document.getElementById('duelFeedback').innerText.replace(/\s+/g, ' ').trim()
  }));
  const waitHeard = (page, rx, timeout = 12000) => page.waitForFunction(r => new RegExp(r).test((document.getElementById('duelHeard') || {}).textContent || ''), rx.source, { timeout }).then(() => true).catch(() => false);
  function measure() {
    const box = id => { const e = document.getElementById(id); if (!e || !e.offsetHeight) return null; const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right) }; };
    const scr = document.getElementById('s-duel').getBoundingClientRect();
    const ids = ['duelTopic', 'duelFeedback', 'duelEq', 'duelHeard', 'duelType'];
    const b = ids.map(id => ({ id, r: box(id) })).filter(x => x.r);
    const out = b.filter(x => x.r.b > Math.min(innerHeight, scr.bottom) + 1 || x.r.l < scr.left - 1 || x.r.r > scr.right + 1).map(x => x.id);
    const over = []; let pairs = 0;
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) { pairs++;
      const v = Math.min(b[i].r.b, b[j].r.b) - Math.max(b[i].r.t, b[j].r.t), h = Math.min(b[i].r.r, b[j].r.r) - Math.max(b[i].r.l, b[j].r.l);
      if (v > 1 && h > 1) over.push(b[i].id + '×' + b[j].id); }
    return { n: b.length, pairs, out, over, win: [innerWidth, innerHeight] };
  }

  try {
    { scenario('Настоящая речь: ни одного касания');
      const page = await openDuel({});
      const a = await info(page);
      check('DUE-01', 'В дуэли нет кнопки записи "Держи и говори"', !a.hold, JSON.stringify(a.buttons));
      const listening = await waitHeard(page, /Слушаю/, 8000);
      check('DUE-02', 'Игра сама слушает и говорит об этом словами', listening, (await info(page)).heard);
      await shot(page, 'duel-390-listening');
      let maxH = 0; for (let i = 0; i < 50 && maxH <= 8; i++) { maxH = Math.max(maxH, ...(await page.evaluate(() => [...document.querySelectorAll('#duelEq i')].map(b => parseFloat(b.style.height) || 0)))); await page.waitForTimeout(100); }
      check('DUE-03', `Шкала голоса двигается от речи (максимум ${maxH.toFixed(1)}px, покой 4px)`, maxH > 8);
      const judged = await page.waitForFunction(() => +document.getElementById('duelYou').textContent > 0, null, { timeout: 25000 }).then(() => true).catch(() => false);
      const b = await info(page);
      check('DUE-04', `Ответ сам ушёл судье: запросов ${page.calls.judge.length}, сказано "${(page.calls.judge[0] || {}).said}", счёт ${b.you}`,
        judged && page.calls.judge.length >= 1 && /one board/i.test((page.calls.judge[0] || {}).said || '') && b.you === 70, JSON.stringify(b));
      check('DUE-05', 'Вердикт судьи показан и соперник тоже набрал очки', /Засчитано/.test(b.fb) && b.ai > 0, b.fb);
      await shot(page, 'duel-390-verdict');
      const again = await page.waitForFunction(() => /Раунд 2/.test(document.getElementById('duelRound').textContent) && /Слушаю/.test(document.getElementById('duelHeard').textContent), null, { timeout: 12000 }).then(() => true).catch(() => false);
      check('DUE-06', 'Раунд 2 начался, и игра снова слушает сама', again, JSON.stringify(await info(page)));
      check('DUE-07', 'Нет ошибок скрипта', page.captured.pageErrors.length === 0, page.captured.pageErrors.join(' | '));
      await page.ctx.close(); }

    { scenario('Микрофон запрещён: ответ можно написать');
      const page = await openDuel({ mic: 'denied', viewport: { width: 766, height: 600 } });
      const told = await waitHeard(page, /напиши ответ/, 8000);
      const a = await info(page);
      check('DUE-10', 'Игра словами говорит, что микрофона нет, и открывает поле ввода', told && /икрофон/.test(a.heard) && a.typeOn, JSON.stringify(a));
      await shot(page, 'duel-766-denied');
      await page.fill('#duelInput', 'I love nasi goreng and fresh mango juice');
      await page.press('#duelInput', 'Enter');
      const judged = await page.waitForFunction(() => +document.getElementById('duelYou').textContent > 0, null, { timeout: 8000 }).then(() => true).catch(() => false);
      check('DUE-11', `Написанный ответ ушёл судье: "${(page.calls.judge[0] || {}).said}"`, judged && /nasi goreng/.test((page.calls.judge[0] || {}).said || ''), JSON.stringify(await info(page)));
      const r2 = await page.waitForFunction(() => /Раунд 2/.test(document.getElementById('duelRound').textContent) && document.getElementById('duelType').offsetHeight > 0, null, { timeout: 8000 }).then(() => true).catch(() => false);
      check('DUE-12', 'В раунде 2 поле ввода снова на месте, дуэль не встала', r2, JSON.stringify(await info(page)));
      await shot(page, 'duel-766-round2');
      check('DUE-13', `Распознавание без микрофона не вызывалось: запросов ${page.calls.transcribe}`, page.calls.transcribe === 0);
      const m = await page.evaluate(measure);
      check('DUE-14', `Окно 766x600: тема, вердикт, статус и поле ввода видны целиком и не наезжают (блоков ${m.n}, пар ${m.pairs}, за краем ${m.out.length}, наложений ${m.over.length})`, m.n >= 4 && !m.out.length && !m.over.length, JSON.stringify(m));
      check('DUE-15', 'Нет ошибок скрипта', page.captured.pageErrors.length === 0, page.captured.pageErrors.join(' | '));
      await page.ctx.close(); }

    { scenario('Микрофон есть, но игрок молчит до конца таймера');
      const page = await openDuel({ mic: 'silent', transcript: 'should not be called' });
      const told = await waitHeard(page, /Не слышу/, 14000);
      const a = await info(page);
      check('DUE-20', 'На тишину игра отвечает "не слышу тебя" и продолжает слушать', told && !a.typeOn, a.heard);
      check('DUE-21', `Тишина не уходит на сервер: распознаваний ${page.calls.transcribe}, запросов судье ${page.calls.judge.length}`, page.calls.transcribe === 0 && page.calls.judge.length === 0);
      const m = await page.evaluate(measure);
      check('DUE-22', `Окно 390x844: блоки дуэли видны целиком и не наезжают (блоков ${m.n}, пар ${m.pairs}, за краем ${m.out.length}, наложений ${m.over.length})`, m.n >= 3 && !m.out.length && !m.over.length, JSON.stringify(m));
      // состояние дуэли закрыто от страницы, поэтому таймер ждём по-настоящему: до 90 секунд
      const ended = await page.waitForFunction(() => /Дуэль окончена|выиграл дуэль/.test(document.body.innerText), null, { timeout: 100000 }).then(() => true).catch(() => false);
      const txt = await page.evaluate(() => document.body.innerText);
      check('DUE-23', 'Таймер дошёл до нуля, дуэль закончилась', ended);
      check('DUE-24', 'Молчавший 0:0 не объявлен победителем', ended && /Дуэль окончена/.test(txt) && !/Ты выиграл дуэль/.test(txt), (txt.match(/Счёт[^\n]*/) || [''])[0]);
      check('DUE-25', 'После конца дуэли игра больше не слушает', (await info(page)).heard === '' , (await info(page)).heard);
      check('DUE-26', 'Нет ошибок скрипта', page.captured.pageErrors.length === 0, page.captured.pageErrors.join(' | '));
      await page.ctx.close(); }
  } catch (e) { check('DUE-00', 'Прогон дошёл до конца', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' / ')); }
  await browser.close(); if (srv) srv.close();
  process.exit(report(BASE ? 'last-run-duel-live.json' : 'last-run-duel.json') ? 1 : 0);
})();
