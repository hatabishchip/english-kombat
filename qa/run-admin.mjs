#!/usr/bin/env node
/* =============================================================================
   ПРОВЕРКИ АДМИНКИ РОМАНА (public/island/admin.html) в headless-браузере
   с полностью заглушенным боевым API. Прод не трогаем.

   Что проверяем (префикс ADM):
     - вход по паролю, отрисовка всех карточек
     - выбор верного ответа сохраняется в правильное поле (по телу сохранения)
     - удаление варианта не сбивает указатель на верный ответ
     - панель статистики: без данных, при ошибке сервера и на РЕАЛЬНОМ ответе
       сервера (форма ответа взята из pvp-server/index.js, /api/island/quiz-stats)
     - ошибки в консоли

   Запуск: node qa/run-admin.mjs   [--headed]
   ============================================================================= */
import {
  loadPlaywright, pickExecutable, startServer, newPage, scenario, check, report, API_HOST
} from './harness.mjs';

const HEADED = process.argv.includes('--headed');

// ответ ровно той формы, что отдаёт pvp-server (см. app.get('/api/island/quiz-stats'))
const SERVER_STATS = {
  total: 10,
  byLevel: { basic: 0, advanced: 2, beginner: 6, mid: 2 },
  byTrack: { basic: 8, advanced: 2 },
  byGoal: { travel: 5, work: 3, self: 2 },
  byTime: { '5': 4, '10': 5, '20+': 1 },
  byExp: { zero: 4, some: 5, talk: 1 },
  perQuestion: [0, 1, 2, 3, 4, 5].map(i => ({ i, asked: 10, correct: 10 - i, pct: (10 - i) * 10 })),
  recent: [
    { at: new Date().toISOString(), player: 'Тестер', level: 'beginner', track: 'basic', correctCount: 3, goal: 'travel', time: '10', exp: 'some' },
    { at: new Date().toISOString(), player: 'Второй', level: 'advanced', track: 'advanced', correctCount: 6, goal: 'work', time: '20+', exp: 'talk' }
  ]
};

async function openAdmin(browser, port, opts = {}) {
  const page = await newPage(browser, opts);
  const saves = [];
  await page.ctx.route(`${API_HOST}/api/island/content`, async route => {
    if (route.request().method() === 'POST') {
      try { saves.push(JSON.parse(route.request().postData() || '{}')); } catch { saves.push(null); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: opts.content || null, updatedAt: null }) });
  });
  page.saves = saves;
  await page.goto(`http://127.0.0.1:${port}/island/admin.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('#pwd', 'qa-pass');
  await page.click('#loginBtn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 8000 });
  return page;
}

(async () => {
  const { chromium } = loadPlaywright();
  const { srv, port } = await startServer();
  const exe = pickExecutable(HEADED);
  const browser = await chromium.launch({ headless: !HEADED, ...(exe ? { executablePath: exe } : {}) });

  try {
    /* ── 1. вход и отрисовка ── */
    scenario('Админка: вход и карточки');
    {
      const page = await openAdmin(browser, port, { statsBody: { total: 0 } });
      check('ADM-01', 'Вход по паролю открывает админку',
        await page.$eval('#app', el => getComputedStyle(el).display !== 'none'));
      for (const k of ['c1', 'c2', 'c3']) {
        const has = await page.$('#' + k + 'text') !== null;
        check(`ADM-02${k}`, `Карточка кружка ${k} нарисована`, has);
      }
      const qBlocks = await page.$$eval('#quizQs .block', els => els.length);
      check('ADM-03', 'Все 6 вопросов теста нарисованы', qBlocks === 6, `блоков: ${qBlocks}`);
      const goalOpts = await page.$$eval('#svGoalOpts .krow', els => els.length);
      check('ADM-04', 'Варианты цели нарисованы', goalOpts === 5, `вариантов: ${goalOpts}`);
      const tags = await page.$$eval('#quizQs .qtag', els => els.map(e => e.textContent));
      check('ADM-05', 'Роль вопросов подписана: №3 и №4 решают Advanced',
        /Advanced/.test(tags[2] || '') && /Advanced/.test(tags[3] || ''), tags.join(' | '));
      check('ADM-06', 'При открытии админки нет ошибок в консоли',
        page.captured.consoleErrors.length === 0, page.captured.consoleErrors.slice(0, 3).join(' | '));
      check('ADM-07', 'При открытии админки нет исключений',
        page.captured.pageErrors.length === 0, page.captured.pageErrors.slice(0, 3).join(' | '));
      await page.ctx.close();
    }

    /* ── 2. выбор верного ответа и удаление варианта ── */
    scenario('Админка: правка теста');
    {
      const page = await openAdmin(browser, port, { statsBody: { total: 0 } });
      // отмечаем верным 3-й вариант первого вопроса
      const radios = await page.$$('#quizQs .block:nth-child(1) .orow input[type=radio]');
      await radios[2].check();
      await page.click('#saveBtn');
      await page.waitForTimeout(400);
      const saved = page.saves[page.saves.length - 1];
      const q0 = saved && saved.data && saved.data.quiz && saved.data.quiz.questions[0];
      check('ADM-08', 'Выбор верного ответа пишется в поле correct', q0 && q0.correct === 2, `correct=${q0 && q0.correct}`);
      check('ADM-09', 'Сохранение уходит целым объектом контента',
        !!(saved && saved.data && saved.data.survey && saved.data.circles), Object.keys((saved && saved.data) || {}).join(','));

      // удаляем вариант, стоящий ПЕРЕД верным: указатель должен остаться на том же тексте
      const before = q0.options.slice();
      const dels = await page.$$('#quizQs .block:nth-child(1) .orow .del');
      await dels[0].click();
      await page.waitForTimeout(200);
      await page.click('#saveBtn');
      await page.waitForTimeout(400);
      const saved2 = page.saves[page.saves.length - 1];
      const q0b = saved2.data.quiz.questions[0];
      check('ADM-10', 'После удаления варианта верным остаётся тот же текст',
        q0b.options[q0b.correct] === before[2], `был "${before[2]}", стал "${q0b.options[q0b.correct]}"`);
      check('ADM-11', 'Указатель верного ответа остаётся в диапазоне',
        q0b.correct >= 0 && q0b.correct < q0b.options.length, `correct=${q0b.correct} из ${q0b.options.length}`);

      // нельзя оставить меньше двух вариантов
      page.on('dialog', d => d.accept());
      const dels2 = await page.$$('#quizQs .block:nth-child(1) .orow .del');
      await dels2[0].click();
      await page.waitForTimeout(300);
      const left = await page.$$eval('#quizQs .block:nth-child(1) .orow', els => els.length);
      check('ADM-12', 'Админка не даёт оставить меньше двух вариантов', left >= 2, `осталось: ${left}`);
      check('ADM-13', 'Правка теста не даёт ошибок в консоли',
        page.captured.consoleErrors.length === 0, page.captured.consoleErrors.slice(0, 3).join(' | '));
      await page.ctx.close();
    }

    /* ── 3. панель статистики ── */
    scenario('Админка: панель статистики');
    {
      const empty = await openAdmin(browser, port, { statsBody: { total: 0 } });
      await empty.waitForTimeout(600);
      const t1 = await empty.$eval('#statsBox', el => el.innerText);
      check('ADM-14', 'Без данных панель показывает пояснение, а не ломается',
        /Статистика появится/.test(t1), t1.slice(0, 120));
      check('ADM-15', 'Пустая статистика не даёт исключений',
        empty.captured.pageErrors.length === 0, empty.captured.pageErrors.slice(0, 2).join(' | '));
      await empty.ctx.close();

      const err = await openAdmin(browser, port, { statsBody: 'error' });
      await err.waitForTimeout(600);
      const t2 = await err.$eval('#statsBox', el => el.innerText);
      check('ADM-16', 'Ошибка сервера статистики не роняет админку',
        /Статистика появится/.test(t2), t2.slice(0, 120));
      await err.ctx.close();

      const page = await openAdmin(browser, port, { statsBody: SERVER_STATS });
      await page.waitForTimeout(800);
      const box = await page.$eval('#statsBox', el => el.innerText);
      check('ADM-17', 'Общее число прохождений показано', /10/.test(box), box.slice(0, 200));
      // сервер отдаёт byLevel = beginner/mid/advanced, а маршруты Basic/Advanced лежат в byTrack
      const basicLine = (box.match(/Маршрут Basic\s*\n?([^\n]*)/) || [])[1] || '';
      check('ADM-18', 'Счётчик маршрута Basic не показывает ноль при 8 игроках на Basic',
        /8/.test(basicLine), `в панели: "Маршрут Basic ${basicLine.trim()}" при byTrack.basic=8 (админка читает byLevel вместо byTrack)`);
      check('ADM-19', 'Имя игрока видно в списке последних прохождений',
        /Тестер/.test(box), 'сервер отдаёт поле player, админка читает r.name - имена не показываются');
      const recentTxt = await page.$$eval('#statsBox .grp', els => {
        const g = els.find(e => /Последние прохождения/.test(e.innerText));
        return g ? g.innerText : '';
      });
      check('ADM-20', 'Число верных ответов видно в списке последних прохождений',
        /\d+ верных/.test(recentTxt),
        `в блоке последних прохождений: "${recentTxt.replace(/\n/g, ' | ').slice(0, 160)}" - сервер отдаёт correctCount, админка читает r.correct`);
      check('ADM-21', 'Распределение по цели показано человеческими подписями',
        /Путешеств/.test(box), box.slice(0, 400));
      check('ADM-22', 'Панель статистики не даёт ошибок в консоли',
        page.captured.consoleErrors.length === 0, page.captured.consoleErrors.slice(0, 3).join(' | '));
      await page.ctx.close();
    }

    /* ── 4. злой серверный контент в админке ── */
    scenario('Админка: злой серверный контент');
    {
      const page = await openAdmin(browser, port, {
        statsBody: { total: 0 },
        content: { quiz: { questions: [{ en: 'x', ask: 'y', options: ['a'], correct: 7 }] }, survey: { goal: { ask: 'g', options: [] } } }
      });
      await page.waitForTimeout(500);
      const blocks = await page.$$eval('#quizQs .block', els => els.length);
      check('ADM-23', 'Кривой серверный тест не ломает отрисовку админки', blocks >= 1, `блоков: ${blocks}`);
      const hint = await page.$eval('#svGoalOpts', el => el.innerText);
      check('ADM-24', 'Пустой список вариантов подсвечен подсказкой', /Вариантов пока нет/.test(hint), hint.slice(0, 120));
      check('ADM-25', 'Кривой контент не даёт исключений в админке',
        page.captured.pageErrors.length === 0, page.captured.pageErrors.slice(0, 2).join(' | '));
      await page.ctx.close();
    }

    /* ── 5. нумерация вопросов в статистике ──
       Сервер отдаёт perQuestion только по тем вопросам, по которым есть данные,
       и каждый ряд подписан своим полем i. Админка же нумерует ряды по позиции
       в массиве - при пропуске данные съезжают на чужой вопрос вместе с пометкой
       «решает Advanced». Роман читает статистику не того вопроса. */
    scenario('Админка: нумерация вопросов в статистике');
    {
      const gapStats = {
        total: 3, byLevel: { beginner: 3 }, byTrack: { basic: 3, advanced: 0 },
        byGoal: { travel: 3 }, byTime: { '5': 3 }, byExp: { zero: 3 },
        // данных по вопросу №2 (i=1) нет вовсе
        perQuestion: [
          { i: 0, asked: 3, correct: 3, pct: 100 },
          { i: 2, asked: 3, correct: 0, pct: 0 },
          { i: 3, asked: 3, correct: 3, pct: 100 },
        ],
        recent: [],
      };
      const page = await openAdmin(browser, port, { statsBody: gapStats });
      await page.waitForTimeout(800);
      const box = await page.$eval('#statsBox', el => el.innerText);
      const rows = box.split('\n').map(s => s.trim());
      const numbered = rows.filter(r => /^№\d/.test(r));
      // ряд с данными по i=2 обязан называться «№3 (решает Advanced)»
      const zeroIdx = rows.findIndex(r => /^0% верно/.test(r));
      const labelForZero = zeroIdx > 0 ? rows[zeroIdx - 1] : '(не найден)';
      check('ADM-26', 'Ряд статистики подписан номером своего вопроса, а не позицией в массиве',
        /^№3/.test(labelForZero),
        `нули по вопросу i=2 (это №3) подписаны как "${labelForZero}"; всего рядов: ${JSON.stringify(numbered)}`);
      check('ADM-27', 'Пометка «решает Advanced» стоит у вопросов №3 и №4, а не у соседей',
        /решает Advanced/.test(labelForZero),
        `подпись ряда с данными вопроса №3: "${labelForZero}"`);
      check('ADM-28', 'Пропуск данных по вопросу не даёт исключений в админке',
        page.captured.pageErrors.length === 0, page.captured.pageErrors.slice(0, 2).join(' | '));
      await page.ctx.close();
    }
  } catch (e) {
    check('RUN-00', 'Стенд админки отработал без падений', false, String(e && e.stack || e));
  } finally {
    await browser.close();
    srv.close();
  }
  process.exit(report('last-run-admin.json') ? 1 : 0);
})();
