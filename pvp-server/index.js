const http = require('http');
const express = require('express');
const { Server, Room } = require('@colyseus/core');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { Schema, MapSchema, type } = require('@colyseus/schema');
const { monitor } = require('@colyseus/monitor');
const { Pool } = require('pg');
const { PHRASES, checkAnswer } = require('./phrases');

// ─── POSTGRES ───
const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pgPool) {
    console.log('[db] DATABASE_URL not set — leaderboard will be in-memory only');
    return;
  }
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS players (
      username TEXT PRIMARY KEY,
      hash TEXT,
      elo INTEGER DEFAULT 1000,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      character TEXT,
      level INTEGER DEFAULT 1,
      completed TEXT[] DEFAULT '{}',
      last_played TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE players ADD COLUMN IF NOT EXISTS hash TEXT;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS completed TEXT[] DEFAULT '{}';
    CREATE INDEX IF NOT EXISTS players_elo_idx ON players (elo DESC);

    CREATE TABLE IF NOT EXISTS phrases (
      id SERIAL PRIMARY KEY,
      ru TEXT NOT NULL,
      en TEXT NOT NULL,
      answers TEXT[] DEFAULT '{}',
      difficulty TEXT DEFAULT 'easy',
      theme TEXT DEFAULT 'general',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS phrases_theme_idx ON phrases (theme, difficulty);
  `);
  // seed if empty
  const { rows } = await pgPool.query('SELECT COUNT(*)::int AS c FROM phrases');
  if (rows[0].c === 0) {
    console.log('[db] seeding phrases from code...');
    for (const diff of ['easy','medium','hard']) {
      const arr = PHRASES[diff] || [];
      for (const p of arr) {
        await pgPool.query(
          `INSERT INTO phrases (ru, en, answers, difficulty, theme)
           VALUES ($1, $2, $3, $4, 'general')`,
          [p.ru, p.en, p.answers || [p.en.toLowerCase()], diff]
        );
      }
    }
    console.log('[db] seeded phrases');
  }
  console.log('[db] schema ready');
}

// Cache of phrases loaded from DB
let PHRASES_CACHE = null;
async function loadPhrases() {
  if (!pgPool) return null;
  try {
    const { rows } = await pgPool.query('SELECT id, ru, en, answers, difficulty, theme FROM phrases ORDER BY id');
    const grouped = { easy: [], medium: [], hard: [] };
    for (const r of rows) {
      const arr = grouped[r.difficulty] || (grouped[r.difficulty] = []);
      arr.push({ id: r.id, ru: r.ru, en: r.en, answers: r.answers || [], theme: r.theme });
    }
    PHRASES_CACHE = grouped;
    console.log('[db] phrases loaded:', rows.length);
    return grouped;
  } catch(e) {
    console.warn('[db] load phrases failed:', e.message);
    return null;
  }
}
function getPhrases() {
  return PHRASES_CACHE || PHRASES;
}

async function dbUpsertPlayer(username, payload) {
  if (!pgPool || !username || username === 'BOT') return;
  try {
    await pgPool.query(
      `INSERT INTO players (username, elo, wins, losses, character, level, last_played)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (username) DO UPDATE SET
         elo = EXCLUDED.elo,
         wins = players.wins + COALESCE($7, 0),
         losses = players.losses + COALESCE($8, 0),
         character = EXCLUDED.character,
         level = EXCLUDED.level,
         last_played = now()`,
      [
        username,
        payload.elo || 1000,
        payload.wins || 0,
        payload.losses || 0,
        payload.character || null,
        payload.level || 1,
        payload.winsDelta || 0,
        payload.lossesDelta || 0,
      ]
    );
  } catch(e) {
    console.warn('[db] upsert failed:', e.message);
  }
}

async function dbGetTopLeaderboard(limit = 50) {
  if (!pgPool) return null;
  try {
    const res = await pgPool.query(
      `SELECT username AS name, elo, wins, losses, character AS char, level
       FROM players
       ORDER BY elo DESC, wins DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  } catch(e) {
    console.warn('[db] leaderboard query failed:', e.message);
    return null;
  }
}

// ─── ELO ───
function eloDelta(myElo, oppElo, won, k = 32) {
  const expected = 1 / (1 + Math.pow(10, (oppElo - myElo) / 400));
  const actual = won ? 1 : 0;
  return Math.round(k * (actual - expected));
}
// in-memory leaderboard: username → { elo, char, level, wins, losses, lastSeen }
const LEADERBOARD = new Map();
function updateLeaderboard(username, payload) {
  if (!username || username === 'BOT') return;
  const prev = LEADERBOARD.get(username) || {};
  LEADERBOARD.set(username, { ...prev, ...payload, lastSeen: Date.now() });
  // cap to top 500 by elo (memory hygiene)
  if (LEADERBOARD.size > 500) {
    const sorted = [...LEADERBOARD.entries()].sort((a, b) => (b[1].elo || 0) - (a[1].elo || 0));
    LEADERBOARD.clear();
    sorted.slice(0, 500).forEach(([k, v]) => LEADERBOARD.set(k, v));
  }
}

// ─── STATE SCHEMAS ───
class Player extends Schema {}
type('string')(Player.prototype, 'name');
type('string')(Player.prototype, 'char');
type('number')(Player.prototype, 'level');
type('number')(Player.prototype, 'elo');
type('number')(Player.prototype, 'hp');
type('boolean')(Player.prototype, 'isActive');
type('boolean')(Player.prototype, 'isBot');

class FightState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
  }
}
type({ map: Player })(FightState.prototype, 'players');
type('string')(FightState.prototype, 'phase');      // waiting | countdown | turn | hit | miss | game_over
type('string')(FightState.prototype, 'phraseRu');
type('string')(FightState.prototype, 'phraseEn');
type('string')(FightState.prototype, 'difficulty'); // easy | medium | hard
type('number')(FightState.prototype, 'turnEndsAt');
type('string')(FightState.prototype, 'winnerId');

// ─── FIGHT ROOM ───
class FightRoom extends Room {
  onCreate(opts) {
    this.maxClients = 2;
    this.bracket = opts.bracket || 1;          // skill bracket — see computeBracket
    this.state = new FightState();
    this.state.phase = 'waiting';
    this.state.difficulty = 'easy';
    // ELO seed: easier difficulty for bracket 1, harder for bracket 2
    if (this.bracket >= 2) this.state.difficulty = 'medium';
    this.usedIds = new Set();
    this.correctCount = 0;
    this.turnTimeout = null;
    this.botFillTimeout = null;
    this.setMetadata({ bracket: this.bracket });
    this.onMessage('answer', (client, msg) => this.handleAnswer(client, msg));
    this.onMessage('leave', (client) => this.disconnect());
    console.log(`[room ${this.roomId}] created (bracket ${this.bracket})`);

    // bot-fill after 30 seconds if no opponent joins
    this.botFillTimeout = setTimeout(() => {
      if (this.state.players.size < 2 && this.state.phase === 'waiting') {
        this.addBot();
      }
    }, 30000);
  }

  onJoin(client, opts) {
    const p = new Player();
    p.name  = (opts.name || 'Anon').slice(0, 16);
    p.char  = opts.char || 'subzero';
    p.level = Math.max(1, Math.min(10, opts.level || 1));
    p.elo   = Math.max(0, Math.min(3000, opts.elo || 1000));
    p.hp    = 100;
    p.isActive = false;
    p.isBot = false;
    this.state.players.set(client.sessionId, p);
    console.log(`[room ${this.roomId}] joined: ${p.name} elo=${p.elo}`);
    if (this.state.players.size === 2) {
      clearTimeout(this.botFillTimeout);
      this.startCountdown();
    }
  }

  addBot() {
    const bot = new Player();
    const botChars = ['subzero','kotal','sareena','nightwolf'];
    bot.name  = 'BOT';
    bot.char  = botChars[Math.floor(Math.random() * botChars.length)];
    bot.level = this.bracket >= 2 ? 7 : 3;
    // bot elo scales with bracket
    bot.elo   = this.bracket >= 2 ? 1300 : 1000;
    bot.hp    = 100;
    bot.isActive = false;
    bot.isBot = true;
    const botId = 'bot_' + Math.random().toString(36).slice(2, 8);
    this.state.players.set(botId, bot);
    this.botId = botId;
    console.log(`[room ${this.roomId}] bot fill: ${bot.char} elo=${bot.elo}`);
    this.startCountdown();
  }

  startCountdown() {
    this.state.phase = 'countdown';
    // pick who goes first
    const ids = Array.from(this.state.players.keys());
    const firstId = ids[Math.floor(Math.random() * ids.length)];
    ids.forEach(id => {
      const p = this.state.players.get(id);
      p.isActive = (id === firstId);
    });
    setTimeout(() => this.startTurn(), 3500);
  }

  pickPhrase() {
    const allPhrases = getPhrases();
    const pool = allPhrases[this.state.difficulty] || allPhrases.easy;
    const avail = pool.filter(p => !this.usedIds.has(p.id));
    const src = avail.length ? avail : pool;
    if (!avail.length) this.usedIds.clear();
    const phrase = src[Math.floor(Math.random() * src.length)];
    this.usedIds.add(phrase.id);
    this.currentPhrase = phrase;
    this.state.phraseRu = phrase.ru;
    this.state.phraseEn = phrase.en;
  }

  startTurn() {
    this.pickPhrase();
    this.state.phase = 'turn';
    this.state.turnEndsAt = Date.now() + 8000;
    clearTimeout(this.turnTimeout);
    this.turnTimeout = setTimeout(() => this.onTimeout(), 8000);
    // if bot's turn → it answers automatically
    const activeId = this.getActiveId();
    const active = this.state.players.get(activeId);
    if (active && active.isBot) {
      const skill = 0.55;
      const correct = Math.random() < skill;
      const said = correct
        ? this.currentPhrase.en
        : ['umm','huh','i dont know','what'][Math.floor(Math.random() * 4)];
      setTimeout(() => this.resolveAnswer(activeId, said, correct), 1500 + Math.random() * 1500);
    }
  }

  getActiveId() {
    for (const [id, p] of this.state.players) {
      if (p.isActive) return id;
    }
    return null;
  }

  handleAnswer(client, msg) {
    if (this.state.phase !== 'turn') return;
    const active = this.state.players.get(client.sessionId);
    if (!active || !active.isActive) return;
    const spoken = (msg.alts && msg.alts[0]) || msg.text || '';
    // SERVER-AUTHORITATIVE validation
    const correct = (msg.alts || [msg.text || '']).some(a => checkAnswer(a, this.currentPhrase.answers));
    this.resolveAnswer(client.sessionId, spoken, correct);
  }

  resolveAnswer(playerId, spoken, correct) {
    clearTimeout(this.turnTimeout);
    const player = this.state.players.get(playerId);
    if (!player) return;
    if (correct) {
      this.correctCount++;
      // damage opponent
      const oppId = this.getOpponentId(playerId);
      const opp = this.state.players.get(oppId);
      if (opp) opp.hp = Math.max(0, opp.hp - 20);
      this.state.phase = 'hit';
      this.broadcast('result', { correct: true, playerId, spoken, answer: this.currentPhrase.en });
      if (opp && opp.hp <= 0) {
        setTimeout(() => this.endFight(playerId), 1500);
        return;
      }
      // upgrade difficulty
      if (this.correctCount === 6 && this.state.difficulty === 'easy') {
        this.state.difficulty = 'medium';
        this.broadcast('diff_up', { level: 'medium' });
      } else if (this.correctCount === 14 && this.state.difficulty === 'medium') {
        this.state.difficulty = 'hard';
        this.broadcast('diff_up', { level: 'hard' });
      }
    } else {
      this.state.phase = 'miss';
      this.broadcast('result', { correct: false, playerId, spoken, answer: this.currentPhrase.en });
    }
    setTimeout(() => this.swap(), 2200);
  }

  onTimeout() {
    if (this.state.phase !== 'turn') return;
    const activeId = this.getActiveId();
    if (!activeId) return;
    this.resolveAnswer(activeId, '(no answer)', false);
  }

  getOpponentId(playerId) {
    for (const id of this.state.players.keys()) {
      if (id !== playerId) return id;
    }
    return null;
  }

  swap() {
    for (const p of this.state.players.values()) {
      p.isActive = !p.isActive;
    }
    this.startTurn();
  }

  endFight(winnerId) {
    clearTimeout(this.turnTimeout);
    this.state.phase = 'game_over';
    this.state.winnerId = winnerId;
    const winner = this.state.players.get(winnerId);
    const loserId = this.getOpponentId(winnerId);
    const loser = this.state.players.get(loserId);
    // compute ELO delta (server-authoritative)
    let deltaWinner = 0, deltaLoser = 0, winnerNewElo = 0, loserNewElo = 0;
    if (winner && loser) {
      deltaWinner = eloDelta(winner.elo, loser.elo, true);
      deltaLoser  = eloDelta(loser.elo, winner.elo, false);
      winnerNewElo = Math.max(0, winner.elo + deltaWinner);
      loserNewElo  = Math.max(0, loser.elo  + deltaLoser);
      // persist to in-memory leaderboard (skip bots)
      if (!winner.isBot) {
        const prev = LEADERBOARD.get(winner.name) || {};
        updateLeaderboard(winner.name, { elo: winnerNewElo, char: winner.char, level: winner.level, wins: (prev.wins || 0) + 1 });
        // persist to Postgres
        dbUpsertPlayer(winner.name, {
          elo: winnerNewElo, character: winner.char, level: winner.level,
          winsDelta: 1, lossesDelta: 0,
        });
      }
      if (!loser.isBot) {
        const prev = LEADERBOARD.get(loser.name) || {};
        updateLeaderboard(loser.name, { elo: loserNewElo, char: loser.char, level: loser.level, losses: (prev.losses || 0) + 1 });
        dbUpsertPlayer(loser.name, {
          elo: loserNewElo, character: loser.char, level: loser.level,
          winsDelta: 0, lossesDelta: 1,
        });
      }
    }
    this.broadcast('game_over', {
      winnerId,
      winnerName: winner ? winner.name : '?',
      elo: {
        [winnerId]: { delta: deltaWinner, newElo: winnerNewElo },
        [loserId]:  { delta: deltaLoser,  newElo: loserNewElo },
      },
    });
    setTimeout(() => this.disconnect(), 5000);
  }

  onLeave(client, consented) {
    console.log(`[room ${this.roomId}] left: ${client.sessionId}`);
    if (this.state.phase !== 'game_over') {
      // opponent left mid-fight — auto-win for remaining
      const remaining = Array.from(this.state.players.keys()).find(id => id !== client.sessionId);
      if (remaining) {
        const remP = this.state.players.get(remaining);
        if (remP && !remP.isBot) this.endFight(remaining);
      }
    }
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    console.log(`[room ${this.roomId}] disposed`);
    clearTimeout(this.turnTimeout);
    clearTimeout(this.botFillTimeout);
  }
}

// ─── BOOT ───
const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});
app.get('/', (_, res) => res.send('English Kombat PvP server — ok'));
app.get('/health', (_, res) => res.send('ok'));
app.get('/leaderboard', async (_, res) => {
  // try Postgres first, fall back to in-memory
  const dbTop = await dbGetTopLeaderboard(50);
  if (dbTop) {
    res.json({ top: dbTop, source: 'db' });
    return;
  }
  const top = [...LEADERBOARD.entries()]
    .map(([name, p]) => ({ name, ...p }))
    .sort((a, b) => (b.elo || 0) - (a.elo || 0))
    .slice(0, 50);
  res.json({ top, source: 'memory' });
});
app.use(express.json({ limit: '2mb' }));
app.use('/colyseus', monitor());

// ─── ACCOUNT SYNC (cross-device login + progress) ───
app.post('/api/auth/sync', async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'no db' });
  const { username, hash, localProfile } = req.body || {};
  if (!username || !hash) return res.status(400).json({ error: 'username/hash required' });
  const u = username.toLowerCase();
  try {
    const { rows } = await pgPool.query('SELECT * FROM players WHERE username = $1', [u]);
    if (rows.length) {
      const row = rows[0];
      // existing user — check hash
      if (row.hash && row.hash !== hash) {
        return res.status(401).json({ error: 'wrong password' });
      }
      // set hash if user existed via PvP play but never auth-synced
      if (!row.hash) {
        await pgPool.query('UPDATE players SET hash = $1 WHERE username = $2', [hash, u]);
        row.hash = hash;
      }
      return res.json({ ok: true, profile: {
        username:  row.username,
        hash:      row.hash,
        elo:       row.elo || 1000,
        wins:      row.wins || 0,
        losses:    row.losses || 0,
        level:     row.level || 1,
        character: row.character || null,
        completed: row.completed || [],
        lastPlayed: row.last_played ? new Date(row.last_played).getTime() : Date.now(),
      }});
    }
    // new user — register, seed with localProfile if provided
    const lp = localProfile || {};
    const newRow = {
      elo: lp.elo || 1000,
      wins: lp.wins || 0,
      losses: lp.losses || 0,
      level: lp.level || 1,
      character: lp.character || null,
      completed: Array.isArray(lp.completed) ? lp.completed : [],
    };
    await pgPool.query(
      `INSERT INTO players (username, hash, elo, wins, losses, level, character, completed, last_played)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [u, hash, newRow.elo, newRow.wins, newRow.losses, newRow.level, newRow.character, newRow.completed]
    );
    res.json({ ok: true, profile: { username: u, hash, ...newRow, lastPlayed: Date.now() }, isNew: true });
  } catch(e) {
    console.warn('[auth] sync failed:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

app.put('/api/auth/profile', async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'no db' });
  const { username, hash, updates } = req.body || {};
  if (!username || !hash) return res.status(400).json({ error: 'auth required' });
  const u = username.toLowerCase();
  try {
    const r = await pgPool.query('SELECT hash FROM players WHERE username = $1', [u]);
    if (!r.rows.length || r.rows[0].hash !== hash) return res.status(401).json({ error: 'auth fail' });
    await pgPool.query(
      `UPDATE players SET
         elo       = COALESCE($1, elo),
         level     = COALESCE($2, level),
         wins      = COALESCE($3, wins),
         losses    = COALESCE($4, losses),
         character = COALESCE($5, character),
         completed = COALESCE($6::text[], completed),
         last_played = now()
       WHERE username = $7`,
      [
        updates.elo ?? null,
        updates.level ?? null,
        updates.wins ?? null,
        updates.losses ?? null,
        updates.character ?? null,
        Array.isArray(updates.completed) ? updates.completed : null,
        u,
      ]
    );
    res.json({ ok: true });
  } catch(e) {
    console.warn('[auth] update failed:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ─── ADMIN PHRASES API ───
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
function checkAdmin(req, res, next) {
  const token = req.headers['x-admin-password'] || req.query.pwd;
  if (token !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ error: 'wrong password' });
});
app.get('/api/phrases', checkAdmin, async (_, res) => {
  if (!pgPool) return res.json({ rows: [] });
  const { rows } = await pgPool.query('SELECT id, ru, en, answers, difficulty, theme FROM phrases ORDER BY id DESC');
  res.json({ rows });
});
app.post('/api/phrases', checkAdmin, async (req, res) => {
  if (!pgPool) return res.status(500).json({ error: 'no db' });
  const { ru, en, answers, difficulty = 'easy', theme = 'general' } = req.body || {};
  if (!ru || !en) return res.status(400).json({ error: 'ru/en required' });
  const ansArr = Array.isArray(answers) && answers.length ? answers.map(a => a.toLowerCase()) : [en.toLowerCase()];
  const { rows } = await pgPool.query(
    `INSERT INTO phrases (ru, en, answers, difficulty, theme)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [ru, en, ansArr, difficulty, theme]
  );
  await loadPhrases();
  res.json({ row: rows[0] });
});
app.put('/api/phrases/:id', checkAdmin, async (req, res) => {
  if (!pgPool) return res.status(500).json({ error: 'no db' });
  const { ru, en, answers, difficulty, theme } = req.body || {};
  const ansArr = Array.isArray(answers) ? answers.map(a => a.toLowerCase()) : null;
  const { rows } = await pgPool.query(
    `UPDATE phrases SET
       ru = COALESCE($1, ru),
       en = COALESCE($2, en),
       answers = COALESCE($3::text[], answers),
       difficulty = COALESCE($4, difficulty),
       theme = COALESCE($5, theme)
     WHERE id = $6 RETURNING *`,
    [ru, en, ansArr, difficulty, theme, req.params.id]
  );
  await loadPhrases();
  res.json({ row: rows[0] });
});
app.delete('/api/phrases/:id', checkAdmin, async (req, res) => {
  if (!pgPool) return res.status(500).json({ error: 'no db' });
  await pgPool.query('DELETE FROM phrases WHERE id = $1', [req.params.id]);
  await loadPhrases();
  res.json({ ok: true });
});
// CSV export — admin-protected
app.get('/api/phrases/export.csv', checkAdmin, async (_, res) => {
  if (!pgPool) return res.status(503).send('no db');
  const { rows } = await pgPool.query('SELECT ru, en, answers, difficulty, theme FROM phrases ORDER BY id');
  const esc = (s) => {
    const str = String(s || '');
    if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const lines = ['ru,en,answers,difficulty,theme'];
  for (const r of rows) {
    lines.push([
      esc(r.ru), esc(r.en),
      esc((r.answers || []).join('|')),
      esc(r.difficulty), esc(r.theme),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="phrases-${Date.now()}.csv"`);
  res.send(lines.join('\n'));
});

// Simple CSV parser supporting quoted fields, escaped quotes, multi-line
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i+1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(x => x.length)) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    return o;
  });
}

app.post('/api/phrases/import', checkAdmin, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'no db' });
  const csv = (req.body && req.body.csv) || '';
  if (!csv) return res.status(400).json({ error: 'empty csv' });
  let parsed;
  try { parsed = parseCSV(csv); }
  catch(e) { return res.status(400).json({ error: 'parse: ' + e.message }); }
  let inserted = 0; const errors = [];
  for (const row of parsed) {
    if (!row.ru || !row.en) { errors.push({ row, why: 'missing ru/en' }); continue; }
    const answers = row.answers ? row.answers.split('|').map(s => s.trim()).filter(Boolean) : [row.en.toLowerCase()];
    try {
      await pgPool.query(
        `INSERT INTO phrases (ru, en, answers, difficulty, theme) VALUES ($1, $2, $3, $4, $5)`,
        [row.ru, row.en, answers, row.difficulty || 'easy', row.theme || 'general']
      );
      inserted++;
    } catch(e) {
      errors.push({ row, why: e.message });
    }
  }
  await loadPhrases();
  res.json({ inserted, totalRows: parsed.length, errors });
});

app.use('/admin', express.static(__dirname + '/admin'));

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// .filterBy(['bracket']) → Colyseus auto-matches clients to rooms with same bracket
gameServer.define('fight', FightRoom).filterBy(['bracket']);

const PORT = process.env.PORT || 2567;
(async () => {
  await initDb();
  await loadPhrases();
  await gameServer.listen(PORT);
  console.log(`⚔  Colyseus PvP server listening on :${PORT}`);
})();
