#!/usr/bin/env node
/* =============================================================================
   СЕРВЕРНЫЕ ПРОВЕРКИ ОСТРОВА - поднимаем pvp-server ЛОКАЛЬНО, БЕЗ базы данных
   (DATABASE_URL не задан) и бьём по эндпоинтам онбординга мусором.
   Боевой сервер и боевая база НЕ трогаются: слушаем свободный порт на 127.0.0.1.

   Что проверяем (префикс SRV):
     - quiz-result без базы: мягкий ответ, а не 500 и не падение процесса
     - quiz-result с мусорным телом (не JSON, answers не массив, чужие типы)
     - quiz-stats без пароля / с паролем / без базы
     - content и upload без пароля
     - процесс живой после всей серии

   Запуск: node qa/run-server.mjs
   ============================================================================= */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { check, report, scenario } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PASS = 'qa-local-pass';

function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(url, body, headers = {}) {
  const init = { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers) };
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  } catch (e) { return { status: 0, text: String(e.message), json: null, netError: true }; }
}
async function get(url, headers = {}) {
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  } catch (e) { return { status: 0, text: String(e.message), json: null, netError: true }; }
}

(async () => {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    PORT: String(port), ADMIN_PASSWORD: PASS,
    MEDIA_DIR: path.join(ROOT, 'qa', '.tmp-media'),
  });
  delete env.DATABASE_URL;            // ключевой случай: сервер БЕЗ базы
  delete env.OPENAI_API_KEY;
  delete env.GROQ_API_KEY;

  const child = spawn('node', [path.join(ROOT, 'pvp-server', 'index.js')], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', d => log.push(String(d)));
  child.stderr.on('data', d => log.push(String(d)));
  let exited = null;
  child.on('exit', (c, s) => { exited = `code=${c} signal=${s}`; });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !exited; i++) {
    const h = await get(base + '/health');
    if (h.status === 200) { up = true; break; }
    await sleep(500);
  }

  scenario('Сервер онбординга без базы данных');
  check('SRV-01', 'Сервер поднимается без DATABASE_URL', up, exited ? `процесс упал: ${exited}\n${log.join('').slice(-800)}` : 'health не ответил за 30с');

  if (up) {
    // ── quiz-result: нормальное тело, но базы нет ──
    const good = {
      player: 'Тестер', goal: 'travel', time: '10', exp: 'some',
      answers: [0, 1, 2, 3, 4, 5].map(i => ({ i, chosen: 1, ok: true })), level: 'advanced', track: 'advanced'
    };
    let r = await post(base + '/api/island/quiz-result', good);
    check('SRV-02', 'quiz-result без базы отвечает 200 с мягким отказом', r.status === 200 && r.json && r.json.ok === false,
      `status=${r.status} body=${r.text.slice(0, 160)}`);

    // ── мусорные тела ──
    const junk = [
      ['пустое тело', {}],
      ['answers = строка', { answers: 'не массив' }],
      ['answers = число', { answers: 42 }],
      ['answers = массив строк', { answers: ['a', 'b'] }],
      ['answers = массив null', { answers: [null, null] }],
      ['answers с чужими типами', { answers: [{ i: 'x', chosen: {}, ok: 'да' }, { i: -5, chosen: 999 }] }],
      ['answers из 500 элементов', { answers: Array.from({ length: 500 }, (_, i) => ({ i, chosen: 0, ok: true })) }],
      ['player = объект', { player: { a: 1 }, answers: [] }],
      ['track/level = объекты', { track: {}, level: [], answers: [] }],
      ['вложенная бесконечная строка', { player: 'я'.repeat(5000), answers: [] }],
      ['нумерация вопросов с единицы', { answers: [1, 2, 3, 4, 5, 6].map(i => ({ i, chosen: 1 })) }],
    ];
    let n = 2;
    for (const [title, body] of junk) {
      r = await post(base + '/api/island/quiz-result', body);
      n++;
      check(`SRV-${String(n).padStart(2, '0')}`, `quiz-result переживает: ${title}`,
        r.status === 200 && !r.netError, `status=${r.status} body=${r.text.slice(0, 200)}`);
    }

    // ── не-JSON тело ──
    r = await post(base + '/api/island/quiz-result', '{это не json', { 'Content-Type': 'application/json' });
    check('SRV-14', 'quiz-result на битом JSON отвечает 4xx, а не 500', r.status >= 400 && r.status < 500,
      `status=${r.status} body=${r.text.slice(0, 200)}`);
    r = await post(base + '/api/island/quiz-result', 'plain text', { 'Content-Type': 'text/plain' });
    check('SRV-15', 'quiz-result на text/plain не падает', r.status === 200 && !r.netError,
      `status=${r.status} body=${r.text.slice(0, 200)}`);

    // ── quiz-stats ──
    r = await get(base + '/api/island/quiz-stats');
    check('SRV-16', 'quiz-stats без пароля отдаёт 401', r.status === 401, `status=${r.status} body=${r.text.slice(0, 120)}`);
    r = await get(base + '/api/island/quiz-stats', { 'X-Admin-Password': 'wrong' });
    check('SRV-17', 'quiz-stats с неверным паролем отдаёт 401', r.status === 401, `status=${r.status}`);
    r = await get(base + '/api/island/quiz-stats', { 'X-Admin-Password': PASS });
    check('SRV-18', 'quiz-stats с паролем, но без базы отвечает понятной ошибкой 503', r.status === 503,
      `status=${r.status} body=${r.text.slice(0, 160)}`);
    r = await get(base + '/api/island/quiz-stats?pwd=' + encodeURIComponent(PASS));
    check('SRV-19', 'Пароль администратора нельзя передать через query-строку URL', r.status === 401,
      `status=${r.status}: пароль принят из ?pwd=, он попадёт в логи и историю браузера`);

    // ── content ──
    r = await get(base + '/api/island/content');
    check('SRV-20', 'content без базы отдаёт пустой контент, а не ошибку',
      r.status === 200 && r.json && r.json.data === null, `status=${r.status} body=${r.text.slice(0, 120)}`);
    r = await post(base + '/api/island/content', { data: { quiz: {} } });
    check('SRV-21', 'content без пароля не пишется', r.status === 401, `status=${r.status}`);
    r = await post(base + '/api/island/content', { data: null }, { 'X-Admin-Password': PASS });
    check('SRV-22', 'content с пустыми данными отклоняется мягко', r.status === 400 || r.status === 503,
      `status=${r.status} body=${r.text.slice(0, 120)}`);

    // ── upload ──
    r = await post(base + '/api/island/upload?key=c1', 'x', { 'Content-Type': 'video/mp4' });
    check('SRV-23', 'upload без пароля запрещён', r.status === 401, `status=${r.status}`);
    r = await post(base + '/api/island/upload?key=../../etc/passwd', 'x', { 'Content-Type': 'video/mp4', 'X-Admin-Password': PASS });
    check('SRV-24', 'upload не даёт вырваться из каталога через ключ',
      r.status === 200 && r.json && r.json.url && !/\.\./.test(r.json.url), `status=${r.status} body=${r.text.slice(0, 160)}`);

    // ── chat ──
    r = await post(base + '/api/island/chat', { persona: 'roman', messages: 'не массив', mode: 'onboarding' });
    check('SRV-25', 'chat с messages не массивом не роняет сервер', r.status < 500 && !r.netError,
      `status=${r.status} body=${r.text.slice(0, 160)}`);

    // ── процесс жив? ──
    await sleep(300);
    const h = await get(base + '/health');
    check('SRV-26', 'После всей серии мусора сервер жив', h.status === 200 && !exited, exited || `health=${h.status}`);
  }

  try { child.kill('SIGKILL'); } catch {}
  const crash = log.join('').match(/UnhandledPromiseRejection|TypeError|ReferenceError/g);
  check('SRV-27', 'В логе сервера нет необработанных исключений', !crash, (crash || []).slice(0, 3).join(', '));

  process.exit(report('last-run-server.json') ? 1 : 0);
})();
