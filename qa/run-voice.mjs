#!/usr/bin/env node
/* =============================================================================
   ГОЛОСОВОЙ СТЕНД: настоящая речь через поддельный микрофон браузера.
   Проверяет то, чего не покрывал ни один прогон: слышит ли игра живую фразу,
   вовремя ли останавливает запись по паузе и засчитывает ли ответ.
   Аудио: qa/audio/p1_pause.wav (фраза «One board please» + 2.5с тишины).
   ⚠️ Ходит в БОЕВОЙ /api/island/transcribe - иначе проверять нечего.
   ============================================================================= */
import { loadPlaywright, pickExecutable, startServer, scenario, check, report } from './harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AUDIO = path.join(__dirname, 'audio', 'p1_pause.wav');
const HEADED = process.argv.includes('--headed');

(async () => {
  const { srv, port } = await startServer();
  const pw = loadPlaywright();
  const exe = pickExecutable(HEADED);
  const browser = await pw.chromium.launch({
    headless: !HEADED,
    ...(exe ? { executablePath: exe } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + AUDIO,
           '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errs = []; const heard = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('response', r => { if (r.url().includes('/api/island/transcribe')) heard.push(r.status()); });

  scenario('Живая речь через поддельный микрофон');
  try {
    await page.goto(`http://127.0.0.1:${port}/island/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#s-perm.on', { timeout: 8000 }).catch(() => {});
    await page.click('#permAllow').catch(() => {});
    await page.waitForSelector('#s-onb.on', { timeout: 12000 }).catch(() => {});

    // сразу в локацию: там тот же голосовой ритм, что и в бою
    await page.evaluate(() => {
      const st = { name: 'Голос', onbDone: true, quizSent: true, permGranted: true, permAsked: true,
        level: 'beginner', track: 'basic', locIdx: 0, phraseIdx: 0, locDone: 0,
        xp: 0, ammo: 0, coins: 0, streak: 1, learned: [] };
      localStorage.setItem('ek_island_v1', JSON.stringify(st));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#s-map.on', { timeout: 12000 }).catch(() => {});
    await page.click('#tabbar .tab:nth-child(2)').catch(() => {});
    const inScene = await page.waitForSelector('#s-scene.on', { timeout: 10000 }).then(() => true).catch(() => false);
    check('VOI-01', 'Локация открылась', inScene);

    // шкала голоса обязана ожить от настоящего звука
    const alive = await page.waitForFunction(() => {
      const bars = document.querySelectorAll('#sceneEq i');
      return [...bars].some(b => parseFloat(b.style.height) > 8);
    }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    check('VOI-02', 'Шкала голоса реагирует на живую речь', alive, 'столбики не поднялись');

    // запись обязана закрыться по паузе и уйти на распознавание
    const sent = await page.waitForFunction(() => window.__voiceSent === true, null, { timeout: 20000 })
      .then(() => true).catch(() => heard.length > 0);
    check('VOI-03', 'Запись ушла на распознавание (автостоп сработал)',
      heard.length > 0 || sent, `запросов транскрибации: ${heard.length}`);

    // Факт зачёта смотрим по СОСТОЯНИЮ, а не по мигающему экрану: после верной фразы
    // она попадает в выученные и даёт банан. Экран к этому моменту уже показывает
    // следующую фразу (урок L-32 - проверять инвариант, а не конкретную картинку).
    const won = await page.waitForFunction(() => {
      try { const s = JSON.parse(localStorage.getItem('ek_island_v1') || '{}');
            return (s.learned || []).length > 0 || (s.ammo || 0) > 0; } catch (e) { return false; }
    }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    const st = await page.evaluate(() => {
      let s = {}; try { s = JSON.parse(localStorage.getItem('ek_island_v1') || '{}'); } catch (e) {}
      return { learned: (s.learned || []).length, ammo: s.ammo || 0,
               phrase: (document.querySelector('#sceneEn') || {}).textContent || '',
               heard: (document.querySelector('#sceneHeard') || {}).textContent || '' };
    });
    check('VOI-04', 'Сказанную вслух фразу засчитали', won,
      `выучено ${st.learned}, бананов ${st.ammo}, на экране "${st.phrase}", услышано "${st.heard}"`);
    check('VOI-05', 'Ноль ошибок в консоли', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    check('VOI-00', 'Стенд отработал без падений', false, String(e && e.message || e));
  } finally {
    await browser.close(); srv.close();
  }
  process.exit(report('last-run-voice.json') ? 1 : 0);
})();
