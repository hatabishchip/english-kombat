#!/usr/bin/env node
/* =============================================================================
   НАБОР РАУНДА 2 - то, что появилось вместе с возобновлением воронки,
   защитой от повторной отправки и новым сопоставлением реплик.

   Сценарии:
     RSM  возобновление и финал воронки (перезагрузка на экране маршрута)
     SND  отправка результата теста (сеть упала - запись не должна пропасть)
     MCH  сопоставление сказанного с вариантами шага (короткие и двусмысленные)
     BRK  битое сохранение не должно превращать игру в кирпич

   Запуск: node qa/run-resume.mjs [--only=RSM] [--headed]
   ============================================================================= */
import { loadPlaywright, pickExecutable, startServer, newPage, openIsland, walkFunnel,
  waitChip, passCircle, allText, state, check, report, scenario } from './harness.mjs';

const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
const HEADED = process.argv.includes('--headed');
const want = id => !ONLY || id.startsWith(ONLY);
const ck = (id, title, pass, detail) => { if (want(id)) check(id, title, pass, detail); };

const pw = loadPlaywright();
const { srv, port } = await startServer();
const browser = await pw.chromium.launch({ headless: !HEADED, executablePath: pickExecutable(HEADED) });

const scr = p => p.evaluate(() => [...document.querySelectorAll('.screen.on')].map(e => e.id).join(','));
/* ждём, пока воронка реально встанет на нужный шаг (шаг пишется в сохранение) */
const reach = (page, s) => page.waitForFunction(st => {
  try { return (JSON.parse(localStorage.getItem('ek_island_v1') || '{}').onb || {}).step === st; } catch { return false; }
}, s, { timeout: 15000 });
async function typeIn(page, text) {
  await page.fill('#onbInput', text);
  await page.press('#onbInput', 'Enter');
  await page.waitForTimeout(2000);
}
async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('#permSkip').catch(() => {});
}

/* ─────────────────────────────────────────────────────────────────────────────
   RSM · воронка дошла до маршрута, но игрок ещё не нажал START
   Ожидание: перезагрузка не отбрасывает человека в начало воронки.
   ───────────────────────────────────────────────────────────────────────────── */
if (want('RSM')) {
  scenario('возобновление после показа маршрута');
  const page = await newPage(browser);
  await openIsland(page, port);
  await walkFunnel(page, { name: 'Возврат', picks: [1, 1, 0, 1, 1, 1] });   // Advanced
  const before = await state(page);
  ck('RSM-01', 'Первый проход дал маршрут Advanced', before.track === 'advanced', 'track=' + before.track);
  ck('RSM-02', 'Результат ушёл на сервер один раз',
    page.captured.quizResults.length === 1, 'отправок ' + page.captured.quizResults.length);

  await reload(page);
  await page.waitForTimeout(4000);
  const after = await state(page);
  const txt = await allText(page).catch(() => '');
  const onMap = (await scr(page)).includes('s-map');
  const keptResult = onMap || /маршрут/.test(txt) || !!(await page.$('#bigStart'));
  ck('RSM-03', 'Перезагрузка на экране маршрута не отбрасывает в начало воронки',
    keptResult, 'экран=' + (await scr(page)) + ' onb=' + JSON.stringify(after.onb) +
    ' чат: ' + txt.split('\n').filter(Boolean).slice(-2).join(' | '));
  ck('RSM-04', 'Маршрут в состоянии не потерян после перезагрузки',
    after.track === before.track, `было ${before.track}, стало ${after.track}`);

  // если воронка всё же началась заново - второй проход не должен расходиться с сервером
  if (!keptResult) {
    await walkFunnel(page, { name: 'Возврат', picks: [0, 0, 1, 0, 0, 0] });  // теперь Basic
    const s2 = await state(page);
    const shown = /Advanced/.test((await allText(page)).split('маршрут')[1] || '') ? 'advanced' : 'basic';
    const sent = page.captured.quizResults[page.captured.quizResults.length - 1] || {};
    ck('RSM-05', 'Показанный маршрут совпадает с записанным на сервере',
      shown === sent.track, `на экране ${shown}, в состоянии ${s2.track}, на сервере ${sent.track}` +
      ` (отправок всего ${page.captured.quizResults.length})`);
  } else {
    ck('RSM-05', 'Показанный маршрут совпадает с записанным на сервере', true, 'воронка не повторялась');
  }
  await page.ctx.close();
}

/* ─────────────────────────────────────────────────────────────────────────────
   SND · отправка результата теста
   Ожидание: пометка «отправлено» ставится по факту доставки, а не до неё,
   иначе игрок навсегда исчезает из статистики Романа.
   ───────────────────────────────────────────────────────────────────────────── */
if (want('SND')) {
  scenario('отправка результата теста при сбое сети');
  const page = await newPage(browser);
  await page.ctx.route('**/api/island/quiz-result', r => r.abort('failed'));
  await openIsland(page, port);
  await walkFunnel(page, { name: 'Сеть', picks: [0, 0, 0, 0, 0, 0] });
  const s1 = await state(page);
  ck('SND-01', 'Игрок увидел маршрут, несмотря на сбой отправки',
    !!s1.track, 'track=' + s1.track);
  ck('SND-02', 'Отправка не помечена выполненной, пока сервер её не принял',
    !s1.quizSent, 'quizSent=' + s1.quizSent + ', дошло записей ' + page.captured.quizResults.length);

  await page.ctx.unroute('**/api/island/quiz-result');
  await page.click('#bigStart');
  await page.waitForTimeout(600);
  await reload(page);
  await page.waitForTimeout(3000);
  ck('SND-03', 'После восстановления сети результат всё-таки доходит до статистики',
    page.captured.quizResults.length >= 1, 'дошло записей ' + page.captured.quizResults.length);

  // сеть в порядке - запись ровно одна, повторов нет
  const p2 = await newPage(browser);
  await openIsland(p2, port);
  await walkFunnel(p2, { name: 'СетьОК', picks: [0, 0, 0, 0, 0, 0] });
  await p2.click('#bigStart');
  await p2.waitForTimeout(500);
  await reload(p2);
  await p2.waitForTimeout(2500);
  ck('SND-04', 'При исправной сети запись ровно одна',
    p2.captured.quizResults.length === 1, 'отправок ' + p2.captured.quizResults.length);
  await p2.ctx.close();
  await page.ctx.close();
}

/* ─────────────────────────────────────────────────────────────────────────────
   MCH · сопоставление сказанного с вариантами шага
   Ожидание: короткие естественные ответы («да», «нет», «5») засчитываются,
   а двусмысленные («воды», когда подходит два варианта) НЕ выбираются молча.
   ───────────────────────────────────────────────────────────────────────────── */
if (want('MCH')) {
  scenario('сопоставление реплик с вариантами шага');
  const page = await newPage(browser);
  await openIsland(page, port);
  await passCircle(page);
  await reach(page, 'name'); await typeIn(page, 'Реплики');

  // цель: однозначное слово из варианта - должно работать (защита от регресса)
  await reach(page, 'goal'); await waitChip(page, /Путешеств/);
  await typeIn(page, 'работа');
  let s = await state(page);
  ck('MCH-01', 'Однозначное слово выбирает вариант цели', s.goalKey === 'work', 'goalKey=' + s.goalKey);
  if (!s.goalKey) { await waitChip(page, /Путешеств/); await (await page.$$('#onbQuick .chip'))[0].click(); }

  // время: «5» - именно так человек отвечает голосом
  await reach(page, 'time'); await waitChip(page, /минут/);
  const aiBefore = page.captured.chatCalls.length;
  await typeIn(page, '5');
  s = await state(page);
  ck('MCH-02', 'Реплика «5» засчитывается как вариант «5 минут»',
    s.daily === '5', 'daily=' + JSON.stringify(s.daily) + ', ушло в AI: ' + (page.captured.chatCalls.length - aiBefore));
  if (!s.daily) { await waitChip(page, /минут/); await (await page.$$('#onbQuick .chip'))[0].click(); }

  // опыт: «нет» и «да» - самые естественные ответы на «Ты уже изучал английский?»
  await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 2, null, { timeout: 14000 });
  await passCircle(page);
  await reach(page, 'exp'); await waitChip(page, /Немного/);
  await typeIn(page, 'нет');
  s = await state(page);
  ck('MCH-03', 'Реплика «нет» засчитывается вариантом «Нет, почти с нуля»',
    s.expKey === 'zero', 'expKey=' + JSON.stringify(s.expKey));
  await page.ctx.close();

  // «да» - отдельная сессия, чтобы шаг был чистым
  const p2 = await newPage(browser);
  await openIsland(p2, port);
  await passCircle(p2);
  await reach(p2, 'name'); await typeIn(p2, 'Реплики2');
  await reach(p2, 'goal'); await waitChip(p2, /./); await (await p2.$$('#onbQuick .chip'))[0].click();
  await reach(p2, 'time'); await waitChip(p2, /./); await (await p2.$$('#onbQuick .chip'))[0].click();
  await p2.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 2, null, { timeout: 14000 });
  await passCircle(p2);
  await reach(p2, 'exp'); await waitChip(p2, /Немного/);
  await typeIn(p2, 'да');
  const s2 = await state(p2);
  ck('MCH-04', 'Реплика «да» засчитывается вариантом «Да, уже могу общаться»',
    s2.expKey === 'talk', 'expKey=' + JSON.stringify(s2.expKey));
  await p2.ctx.close();

  // двусмысленная реплика на шаге цели: два варианта начинаются одинаково
  const amb = { survey: { goal: { ask: 'Зачем?', options: [
    { k: 'office', label: 'Работа в офисе' }, { k: 'abroad', label: 'Работа за границей' }] } } };
  const p3 = await newPage(browser, { content: amb });
  await openIsland(p3, port);
  await passCircle(p3);
  await reach(p3, 'name'); await typeIn(p3, 'Реплики3');
  await reach(p3, 'goal'); await waitChip(p3, /Работа/);
  await typeIn(p3, 'работа');
  const s3 = await state(p3);
  ck('MCH-05', 'Двусмысленная реплика не выбирает первый вариант молча',
    !s3.goalKey, 'выбрано ' + JSON.stringify(s3.goal) + ' (подходили оба варианта)');
  await p3.ctx.close();

  // двусмысленная реплика на вопросе теста - она влияет на маршрут
  const p4 = await newPage(browser);
  await openIsland(p4, port);
  await walkFunnelToQuiz(p4);
  await typeIn(p4, 'воды');
  const s4 = await state(p4);
  const picked = ((s4.onb || {}).answers || [])[0];
  ck('MCH-06', 'Двусмысленная реплика в тесте не засчитывается ответом молча',
    !picked, 'засчитан вариант №' + (picked && picked.chosen) + ' (ok=' + (picked && picked.ok) + ')');
  await p4.ctx.close();
}

async function walkFunnelToQuiz(page) {
  await passCircle(page);
  await reach(page, 'name'); await typeIn(page, 'Тест');
  await reach(page, 'goal'); await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
  await reach(page, 'time'); await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
  await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 2, null, { timeout: 14000 });
  await passCircle(page);
  await reach(page, 'exp'); await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
  await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 3, null, { timeout: 14000 });
  await passCircle(page);
  await page.waitForFunction(() => /Вопрос 1 из/.test(document.querySelector('#chatScroll').innerText), null, { timeout: 14000 });
}

/* ─────────────────────────────────────────────────────────────────────────────
   BRK · сохранение испорчено (другая версия приложения, ручная правка, сбой)
   Ожидание: игра переживает это и показывает хоть какой-то экран.
   Мёртвый белый экран без выхода - худший из возможных исходов.
   ───────────────────────────────────────────────────────────────────────────── */
if (want('BRK')) {
  scenario('битое сохранение не превращает игру в кирпич');
  const cases = [
    ['BRK-01', 'answers не массив', { step: 'quiz', qi: 1, answers: 'мусор' }],
    ['BRK-02', 'answers с пустыми элементами', { step: 'quiz', qi: 9, answers: [null, 7, { i: 'x' }] }],
    ['BRK-03', 'qi отрицательный', { step: 'quiz', qi: -5, answers: [] }],
    ['BRK-04', 'qi не число', { step: 'quiz', qi: 'три', answers: [] }],
    ['BRK-05', 'неизвестный шаг', { step: 'КАКОЙ-ТО', qi: 0, answers: [] }],
    ['BRK-06', 'onb - строка', 'сломано'],
  ];
  for (const [id, title, onb] of cases) {
    const page = await newPage(browser, { storage: JSON.stringify({ name: 'Кирпич', permAsked: true, onb }) });
    await openIsland(page, port);
    await page.waitForTimeout(3500);
    const on = await scr(page);
    const errs = page.captured.pageErrors.length;
    ck(id, `Сохранение «${title}» не оставляет игрока без экрана`,
      !!on && errs === 0, `экран=${JSON.stringify(on)}, исключений ${errs}: ${page.captured.pageErrors[0] || '-'}`);
    await page.ctx.close();
  }
  // и главное: после такого сохранения перезагрузка тоже должна выводить игрока
  const page = await newPage(browser, { storage: JSON.stringify({ name: 'Кирпич', permAsked: true, onb: { step: 'quiz', qi: 1, answers: 'мусор' } }) });
  await openIsland(page, port);
  await page.waitForTimeout(2500);
  await reload(page);
  await page.waitForTimeout(2500);
  ck('BRK-07', 'Повторный вход с битым сохранением не остаётся кирпичом',
    !!(await scr(page)), 'экран=' + JSON.stringify(await scr(page)));
  await page.ctx.close();
}

/* ─────────────────────────────────────────────────────────────────────────────
   NAM · подстановка имени в текст маршрута
   ───────────────────────────────────────────────────────────────────────────── */
if (want('NAM')) {
  scenario('подстановка имени в маршрут');
  for (const [id, name] of [['NAM-01', `$'`], ['NAM-02', '$&'], ['NAM-03', `О'Брайен "Р" & <b>`]]) {
    const page = await newPage(browser);
    await openIsland(page, port);
    await walkFunnel(page, { name });
    const line = (await allText(page)).split('\n').find(l => /маршрут/.test(l)) || '';
    ck(id, `Имя «${name}» подставляется в маршрут без порчи текста`,
      line.includes(name) && !line.includes('{name}') && !/&quot;|&#39;|&amp;/.test(line), 'строка: ' + line.slice(0, 90));
    await page.ctx.close();
  }
}

await browser.close();
srv.close();
process.exit(report('last-run-resume.json') ? 1 : 0);
