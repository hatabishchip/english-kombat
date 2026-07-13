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
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // PGSSL=disable для локального/докерного Postgres без TLS (VPS); по умолчанию ssl как на Render
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    })
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

    -- friends (symmetric: when A adds B, two rows created)
    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (user_id, friend_id)
    );

    -- clans
    CREATE TABLE IF NOT EXISTS clans (
      id SERIAL PRIMARY KEY,
      tag TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      color TEXT DEFAULT '#ffd100',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS clan_members (
      clan_id INTEGER REFERENCES clans(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (clan_id, username),
      UNIQUE (username)
    );
    CREATE INDEX IF NOT EXISTS clans_tag_idx ON clans (tag);

    -- clan chat messages
    CREATE TABLE IF NOT EXISTS clan_messages (
      id SERIAL PRIMARY KEY,
      clan_id INTEGER REFERENCES clans(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS clan_messages_clan_idx ON clan_messages (clan_id, id DESC);

    -- global chat
    CREATE TABLE IF NOT EXISTS global_messages (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS global_messages_idx ON global_messages (id DESC);

    -- key-value storage (roadmap checklist etc.)
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT now()
    );
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
type('number')(Player.prototype, 'team');     // 0 or 1 (for 2v2)

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

// ─── ISLAND PRACTICE LOBBY (talk3/talk5 — общая комната с AI-ведущим) ───
class LobbyPlayer extends Schema {}
type('string')(LobbyPlayer.prototype, 'name');
type('string')(LobbyPlayer.prototype, 'emoji');
class LobbyState extends Schema {
  constructor() { super(); this.players = new MapSchema(); }
}
type({ map: LobbyPlayer })(LobbyState.prototype, 'players');
type('string')(LobbyState.prototype, 'topic');

const LOBBY_TOPICS = [
  'Introduce yourself in English 👋',
  'What did you eat today? 🍜',
  'Your favorite place on the island 🏝️',
  'Describe your dream vacation ✈️',
  'What music do you like? 🎧',
  'Talk about your best friend 👫',
];
class IslandLobby extends Room {
  onCreate() {
    this.maxClients = 6;
    this.state = new LobbyState();
    this.topicIdx = 0;
    this.state.topic = LOBBY_TOPICS[0];
    this.onMessage('say', (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      const text = String((msg && msg.text) || '').slice(0, 300);
      if (!p || !text) return;
      this.broadcast('msg', { name: p.name, emoji: p.emoji, text, self: client.sessionId }, { });
    });
    // AI-ведущий: ротация темы каждые 50 сек
    this.topicTimer = this.clock.setInterval(() => {
      this.topicIdx = (this.topicIdx + 1) % LOBBY_TOPICS.length;
      this.state.topic = LOBBY_TOPICS[this.topicIdx];
      this.broadcast('host', { text: 'New topic: ' + this.state.topic });
    }, 50000);
  }
  onJoin(client, opts) {
    const p = new LobbyPlayer();
    p.name = String((opts && opts.name) || 'Guest').slice(0, 18);
    p.emoji = String((opts && opts.emoji) || '🙂').slice(0, 4);
    this.state.players.set(client.sessionId, p);
    this.broadcast('host', { text: p.emoji + ' ' + p.name + ' joined the room 👋' });
  }
  onLeave(client) {
    const p = this.state.players.get(client.sessionId);
    if (p) this.broadcast('host', { text: p.name + ' left' });
    this.state.players.delete(client.sessionId);
  }
  onDispose() { this.topicTimer && this.topicTimer.clear(); }
}

// ─── FIGHT ROOM ───
class FightRoom extends Room {
  onCreate(opts) {
    this.mode    = opts.mode || '1v1';     // '1v1' or '2v2'
    this.maxClients = this.mode === '2v2' ? 4 : 2;
    this.bracket = opts.bracket || 1;
    this.code    = opts.code || null;
    this.state = new FightState();
    this.state.phase = 'waiting';
    this.state.difficulty = 'easy';
    if (this.bracket >= 2) this.state.difficulty = 'medium';
    this.usedIds = new Set();
    this.correctCount = 0;
    this.turnTimeout = null;
    this.botFillTimeout = null;
    this.turnOrder = [];      // ordered sessionIds for who-goes-next
    this.turnIndex = 0;
    this.setMetadata({ mode: this.mode, bracket: this.bracket, code: this.code });
    this.onMessage('answer', (client, msg) => this.handleAnswer(client, msg));
    this.onMessage('leave', () => this.disconnect());
    console.log(`[room ${this.roomId}] created mode=${this.mode} bracket=${this.bracket} code=${this.code || '-'}`);

    const botFillMs = this.code ? 90000 : 30000;
    this.botFillTimeout = setTimeout(() => {
      while (this.state.players.size < this.maxClients && this.state.phase === 'waiting') {
        this.addBot();
      }
    }, botFillMs);
  }

  assignTeam() {
    // for 2v2: first 2 to join = team 0, next 2 = team 1
    return this.state.players.size < 2 ? 0 : 1;
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
    p.team  = this.mode === '2v2' ? this.assignTeam() : 0;
    this.state.players.set(client.sessionId, p);
    markOnline(p.name.toLowerCase());
    console.log(`[room ${this.roomId}] joined: ${p.name} team=${p.team}`);
    if (this.state.players.size === this.maxClients) {
      clearTimeout(this.botFillTimeout);
      this.startCountdown();
    }
  }

  addBot() {
    const bot = new Player();
    const botChars = ['subzero','shrek','barbie','merkel'];
    const humanNames = ['Alex','Dima','Olga','Max','Ivan','Kate','Leo','Nina','Tolik','Mia'];
    bot.name  = humanNames[Math.floor(Math.random() * humanNames.length)];
    bot.char  = botChars[Math.floor(Math.random() * botChars.length)];
    bot.level = this.bracket >= 2 ? 7 : 3;
    bot.elo   = this.bracket >= 2 ? 1300 : 1000;
    bot.hp    = 100;
    bot.isActive = false;
    bot.isBot = true;
    bot.team  = this.mode === '2v2' ? this.assignTeam() : 0;
    const botId = 'bot_' + Math.random().toString(36).slice(2, 8);
    this.state.players.set(botId, bot);
    console.log(`[room ${this.roomId}] bot fill: ${bot.char} team=${bot.team}`);
    if (this.state.players.size === this.maxClients) {
      this.startCountdown();
    }
  }

  startCountdown() {
    this.state.phase = 'countdown';
    const ids = Array.from(this.state.players.keys());
    // build turn order: interleave teams (team0 → team1 → team0 → team1)
    if (this.mode === '2v2') {
      const t0 = ids.filter(id => this.state.players.get(id).team === 0);
      const t1 = ids.filter(id => this.state.players.get(id).team === 1);
      this.turnOrder = [];
      for (let i = 0; i < Math.max(t0.length, t1.length); i++) {
        if (t0[i]) this.turnOrder.push(t0[i]);
        if (t1[i]) this.turnOrder.push(t1[i]);
      }
    } else {
      this.turnOrder = ids;
    }
    this.turnIndex = 0;
    const firstId = this.turnOrder[this.turnIndex];
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
    let targetId = null;
    if (correct) {
      this.correctCount++;
      // pick target: random ALIVE opponent (different team)
      const oppTeam = player.team === 0 ? 1 : 0;
      const aliveOpps = Array.from(this.state.players.entries())
        .filter(([id, p]) => p.team === oppTeam && p.hp > 0);
      if (aliveOpps.length) {
        const pick = aliveOpps[Math.floor(Math.random() * aliveOpps.length)];
        targetId = pick[0];
        pick[1].hp = Math.max(0, pick[1].hp - 20);
      }
      this.state.phase = 'hit';
      this.broadcast('result', { correct: true, playerId, targetId, spoken, answer: this.currentPhrase.en });
      // check win — team with all 0 HP loses
      const t0Alive = Array.from(this.state.players.values()).filter(p => p.team === 0 && p.hp > 0).length;
      const t1Alive = Array.from(this.state.players.values()).filter(p => p.team === 1 && p.hp > 0).length;
      if (t0Alive === 0 || t1Alive === 0) {
        setTimeout(() => this.endFight(playerId), 1500);
        return;
      }
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
    // advance turn — skip dead players
    if (this.turnOrder.length === 0) {
      // legacy fallback
      for (const p of this.state.players.values()) p.isActive = !p.isActive;
      this.startTurn();
      return;
    }
    let attempts = 0;
    do {
      this.turnIndex = (this.turnIndex + 1) % this.turnOrder.length;
      attempts++;
    } while (
      attempts < this.turnOrder.length * 2 &&
      (this.state.players.get(this.turnOrder[this.turnIndex])?.hp || 0) <= 0
    );
    const activeId = this.turnOrder[this.turnIndex];
    for (const [id, p] of this.state.players) {
      p.isActive = (id === activeId);
    }
    this.startTurn();
  }

  endFight(triggerId) {
    clearTimeout(this.turnTimeout);
    this.state.phase = 'game_over';
    const triggerPlayer = this.state.players.get(triggerId);
    if (!triggerPlayer) {
      this.broadcast('game_over', { winnerTeam: 0, winnerId: triggerId, winnerName: '?', elo: {} });
      setTimeout(() => this.disconnect(), 5000);
      return;
    }
    const winnerTeam = triggerPlayer.team;
    // build winners/losers arrays
    const winners = [], losers = [];
    for (const [id, p] of this.state.players) {
      (p.team === winnerTeam ? winners : losers).push({ id, p });
    }
    // average opp ELO per side (for individual delta calculation)
    const avg = arr => arr.length ? arr.reduce((s, x) => s + x.p.elo, 0) / arr.length : 1000;
    const winAvg = avg(winners), losAvg = avg(losers);
    const eloUpdates = {};
    for (const { id, p } of winners) {
      const delta = eloDelta(p.elo, losAvg, true);
      const newElo = Math.max(0, p.elo + delta);
      eloUpdates[id] = { delta, newElo };
      if (!p.isBot) {
        const prev = LEADERBOARD.get(p.name) || {};
        updateLeaderboard(p.name, { elo: newElo, char: p.char, level: p.level, wins: (prev.wins || 0) + 1 });
        dbUpsertPlayer(p.name, { elo: newElo, character: p.char, level: p.level, winsDelta: 1, lossesDelta: 0 });
      }
    }
    for (const { id, p } of losers) {
      const delta = eloDelta(p.elo, winAvg, false);
      const newElo = Math.max(0, p.elo + delta);
      eloUpdates[id] = { delta, newElo };
      if (!p.isBot) {
        const prev = LEADERBOARD.get(p.name) || {};
        updateLeaderboard(p.name, { elo: newElo, char: p.char, level: p.level, losses: (prev.losses || 0) + 1 });
        dbUpsertPlayer(p.name, { elo: newElo, character: p.char, level: p.level, winsDelta: 0, lossesDelta: 1 });
      }
    }
    this.broadcast('game_over', {
      winnerTeam,
      winnerId: winners[0]?.id || triggerId,
      winnerName: winners.map(w => w.p.name).join(' + '),
      elo: eloUpdates,
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
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/', (_, res) => res.send('English Kombat PvP server — ok'));
app.get('/health', (_, res) => res.send('ok'));
app.get('/leaderboard', async (_, res) => {
  const online = onlineSet();
  const dbTop = await dbGetTopLeaderboard(50);
  if (dbTop) {
    res.json({ top: dbTop.map(r => ({ ...r, online: online.has(r.name) })), source: 'db', onlineCount: online.size });
    return;
  }
  const top = [...LEADERBOARD.entries()]
    .map(([name, p]) => ({ name, ...p, online: online.has(name) }))
    .sort((a, b) => (b.elo || 0) - (a.elo || 0))
    .slice(0, 50);
  res.json({ top, source: 'memory', onlineCount: online.size });
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

// ─── ONLINE PRESENCE ───
const ONLINE = new Map(); // username -> lastSeen ms
const ONLINE_TTL = 90 * 1000; // 90 sec = still online
function markOnline(username) {
  if (!username || username === 'BOT') return;
  ONLINE.set(username, Date.now());
}
function isOnline(username) {
  const t = ONLINE.get(username);
  return !!(t && Date.now() - t < ONLINE_TTL);
}
function onlineSet() {
  const now = Date.now();
  const set = new Set();
  for (const [u, t] of ONLINE) {
    if (now - t < ONLINE_TTL) set.add(u);
    else ONLINE.delete(u);
  }
  return set;
}

// ─── USER AUTH HELPER (for friends/clans endpoints) ───
async function authUserFromReq(req) {
  const username = (req.body?.username || req.query.username || '').toLowerCase();
  const hash     = req.body?.hash || req.query.hash || '';
  if (!username || !hash || !pgPool) return null;
  const r = await pgPool.query('SELECT hash FROM players WHERE username = $1', [username]);
  if (!r.rows.length || r.rows[0].hash !== hash) return null;
  markOnline(username);   // any authed request = activity
  return username;
}

// Heartbeat endpoint — keeps user "online"
app.post('/api/heartbeat', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  res.json({ ok: true, onlineCount: onlineSet().size });
});

// Public: count of online users
app.get('/api/online/count', (_, res) => {
  res.json({ count: onlineSet().size });
});

// ─── ROADMAP CHECKLIST (shared kv storage; страница /plan) ───
const KV_KEY_RE = /^[a-z0-9_-]{1,64}$/;
app.get('/api/roadmap/:key', async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'no db' });
  if (!KV_KEY_RE.test(req.params.key)) return res.status(400).json({ error: 'bad key' });
  try {
    const { rows } = await pgPool.query('SELECT data, updated_at FROM kv_store WHERE key = $1', [req.params.key]);
    if (!rows.length) return res.json({ data: null });
    res.json({ data: rows[0].data, updatedAt: rows[0].updated_at });
  } catch (e) {
    console.error('[roadmap:get]', e.message);
    res.status(500).json({ error: 'db' });
  }
});
app.post('/api/roadmap/:key', async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'no db' });
  if (!KV_KEY_RE.test(req.params.key)) return res.status(400).json({ error: 'bad key' });
  const data = req.body && req.body.data;
  if (data === undefined) return res.status(400).json({ error: 'data required' });
  try {
    await pgPool.query(
      `INSERT INTO kv_store (key, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = now()`,
      [req.params.key, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[roadmap:post]', e.message);
    res.status(500).json({ error: 'db' });
  }
});

// ─── ISLAND · AI CHAT (Фаза 2: живое общение) ───
// Персонажи острова (ava4). Каждый — свой характер, акцент, био.
const ISLAND_PERSONAS = {
  roman:  { name: 'Роман',  emoji: '🧔', accent: 'обычный', bio: 'основатель острова, весёлый наставник, свой парень, подбадривает' },
  kadek:  { name: 'Kadek',  emoji: '🏄', accent: 'Balinese', bio: 'местный серфер с Бали, спокойный, любит океан и закаты' },
  mia:    { name: 'Mia',    emoji: '💃', accent: 'American', bio: 'диджей из Калифорнии, энергичная, сленг, эмодзи' },
  tom:    { name: 'Tom',    emoji: '🎩', accent: 'British', bio: 'вежливый британец, чуть ироничный, любит чай и порядок' },
  hiro:   { name: 'Hiro',   emoji: '🍣', accent: 'Japanese', bio: 'турист из Токио, дружелюбный, немного стеснительный' },
  sofia:  { name: 'Sofia',  emoji: '🌮', accent: 'Mexican', bio: 'хозяйка кафе, тёплая, кормит и болтает' },
  liam:   { name: 'Liam',   emoji: '🛵', accent: 'Australian', bio: 'прокатчик байков, расслабленный, зовёт всех mate' },
  amara:  { name: 'Amara',  emoji: '🧘', accent: 'Nigerian', bio: 'йога-инструктор, мудрая, спокойная, добрая' },
  chen:   { name: 'Chen',   emoji: '📸', accent: 'Chinese', bio: 'фотограф-путешественник, любопытный, задаёт вопросы' },
  pierre: { name: 'Pierre', emoji: '🥐', accent: 'French', bio: 'шеф-повар, страстный, немного драматичный' },
  nadia:  { name: 'Nadia',  emoji: '🎨', accent: 'neutral', bio: 'художница-кочевник, творческая, вдумчивая' },
  bruno:  { name: 'Bruno',  emoji: '⚽', accent: 'Brazilian', bio: 'тренер по футболу на пляже, громкий, весёлый' },
};
function islandSystemPrompt(personaKey, userName, level, goal) {
  const p = ISLAND_PERSONAS[personaKey] || ISLAND_PERSONAS.roman;
  const lvl = level === 'advanced'
    ? 'Reply in natural English at B2 level with richer vocabulary and idioms, still 1 to 2 sentences.'
    : 'Reply mostly in SIMPLE English (A2-B1), short - 1 to 2 sentences, like a real chat message.';
  const goalLine = goal ? `The learner's real goal is: "${goal}". Now and then, naturally connect the chat to this goal to keep them motivated (do not force it every message).` : '';
  return [
    `You are ${p.name} ${p.emoji}, a character on a tropical English-learning island game called "English Kombat".`,
    `Personality: ${p.bio}. Accent flavour: ${p.accent}.`,
    `You are chatting with a Russian-speaking learner named ${userName || 'friend'} who is practising English.`,
    goalLine,
    `RULES:`,
    `1) ${lvl} Use emoji naturally.`,
    `2) Always end with a light question to keep the conversation going.`,
    `3) If the learner makes an English mistake, do NOT scold. Gently model the correct version inside your reply (recasting).`,
    `4) A few Russian words are OK to keep them comfortable, but keep English dominant.`,
    `5) Stay fully in character as ${p.name}. Never mention you are an AI or a model.`,
    `6) NEVER use an em dash (—). Use a normal hyphen or comma.`,
    `Return STRICT JSON only: {"reply": "<your message>", "correction": "<corrected version of the learner's last English phrase, or empty string if it was fine or not English>"}`,
  ].join('\n');
}
async function callGroq(system, history) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('no groq key');
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const messages = [{ role: 'system', content: system }, ...history];
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.8, max_tokens: 220, response_format: { type: 'json_object' } }),
  });
  if (!r.ok) throw new Error('groq ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}
async function callGemini(system, history) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no gemini key');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const contents = history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.8, maxOutputTokens: 220, responseMimeType: 'application/json' } }),
  });
  if (!r.ok) throw new Error('gemini ' + r.status);
  const j = await r.json();
  return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
}
function parseChatJson(raw, personaKey) {
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.reply === 'string') return { reply: j.reply.replace(/[—–]/g, '-'), correction: (j.correction || '').replace(/[—–]/g, '-') };
  } catch (e) {}
  // модель вернула просто текст — обернём
  const txt = String(raw || '').trim().replace(/[—–]/g, '-');
  return { reply: txt || 'Nice! Tell me more 🙂', correction: '' };
}
app.post('/api/island/chat', async (req, res) => {
  const { messages, persona, userName, level, goal } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  // ограничим контекст последними 12 репликами (talk7 — память)
  const history = messages.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 500) }));
  const system = islandSystemPrompt(persona, userName, level, String(goal || '').slice(0, 80));
  let raw = '', via = '';
  try { raw = await callGroq(system, history); via = 'groq'; }
  catch (e1) {
    try { raw = await callGemini(system, history); via = 'gemini'; }
    catch (e2) {
      console.error('[island:chat] both failed', e1.message, e2.message);
      const p = ISLAND_PERSONAS[persona] || ISLAND_PERSONAS.roman;
      return res.json({ reply: `Hey! I'm a bit busy catching waves 🌊 Say that again? (${p.name})`, correction: '', via: 'fallback' });
    }
  }
  const out = parseChatJson(raw, persona);
  res.json({ ...out, via });
});

// ─── ISLAND · DUEL JUDGE (Фаза 3: fight6 — LLM-судья) ───
// Оценивает реплику игрока на заданную тему: очки 0-100 + короткий вердикт + улучшенная версия.
app.post('/api/island/judge', async (req, res) => {
  const { topic, said, round } = req.body || {};
  const phrase = String(said || '').slice(0, 300);
  if (!phrase.trim()) return res.json({ score: 0, verdict: 'Тишина в эфире 🎤', better: '' });
  const system = [
    'You are a fair, encouraging English-duel judge in a fun game.',
    `The player was asked to say something in English about the topic: "${topic || 'anything'}".`,
    'Score their line from 0 to 100 based on: did they actually speak English, grammar, relevance to topic, and effort. Be generous but honest. Empty or non-English = low score.',
    'Give a SHORT punchy verdict in RUSSIAN (max 8 words, like a boxing commentator), and one improved English version of their line.',
    'NEVER use an em dash. Return STRICT JSON: {"score": <0-100 int>, "verdict": "<ru, short>", "better": "<improved english>"}',
  ].join('\n');
  const history = [{ role: 'user', content: `Round ${round || 1}. My line: "${phrase}"` }];
  let raw = '';
  try { raw = await callGroq(system, history); }
  catch (e1) { try { raw = await callGemini(system, history); } catch (e2) {
    // офлайн-эвристика
    const words = phrase.trim().split(/\s+/).length;
    const looksEn = /[a-z]/i.test(phrase);
    const score = looksEn ? Math.min(90, 40 + words * 6) : 15;
    return res.json({ score, verdict: looksEn ? 'Неплохо, боец! 👊' : 'Это не по-английски 😅', better: '' });
  } }
  try {
    const j = JSON.parse(raw);
    return res.json({
      score: Math.max(0, Math.min(100, parseInt(j.score, 10) || 0)),
      verdict: String(j.verdict || 'Есть контакт!').replace(/[—–]/g, '-').slice(0, 60),
      better: String(j.better || '').replace(/[—–]/g, '-').slice(0, 200),
    });
  } catch (e) {
    return res.json({ score: 55, verdict: 'Засчитано! 👊', better: '' });
  }
});

// ─── ISLAND · DIALOG ANALYSIS (talk4 — AI разбирает диалог) ───
app.post('/api/island/analyze', async (req, res) => {
  const { messages } = req.body || {};
  const userLines = (Array.isArray(messages) ? messages : []).filter(m => m.role === 'user').map(m => String(m.content || '').slice(0, 300)).slice(-15);
  if (!userLines.length) return res.json({ level: 'A1', praise: '', mistakes: [], tip: 'Скажи пару фраз, и я разберу их 🙂' });
  const system = [
    'You are a warm English coach reviewing a learner\'s chat messages.',
    'Analyse ONLY the learner lines given. Output in RUSSIAN except example English phrases.',
    'Estimate CEFR level (A1..C1). Find up to 3 concrete mistakes; for each give {wrong, right, why(short ru)}. Give one genuine praise (ru) and one actionable tip (ru).',
    'Be encouraging, never harsh. NEVER use an em dash.',
    'Return STRICT JSON: {"level":"A2","praise":"...","mistakes":[{"wrong":"...","right":"...","why":"..."}],"tip":"..."}',
  ].join('\n');
  const history = [{ role: 'user', content: 'My messages:\n' + userLines.map((l, i) => (i + 1) + '. ' + l).join('\n') }];
  let raw = '';
  try { raw = await callGroq(system, history); }
  catch (e1) { try { raw = await callGemini(system, history); } catch (e2) {
    return res.json({ level: '-', praise: 'Ты практикуешься - это главное! 💪', mistakes: [], tip: 'Продолжай говорить каждый день.' });
  } }
  try {
    const j = JSON.parse(raw);
    const clean = s => String(s || '').replace(/[—–]/g, '-');
    return res.json({
      level: clean(j.level).slice(0, 4),
      praise: clean(j.praise).slice(0, 200),
      mistakes: (Array.isArray(j.mistakes) ? j.mistakes : []).slice(0, 3).map(m => ({ wrong: clean(m.wrong).slice(0, 120), right: clean(m.right).slice(0, 120), why: clean(m.why).slice(0, 140) })),
      tip: clean(j.tip).slice(0, 200),
    });
  } catch (e) { return res.json({ level: '-', praise: 'Хорошая практика!', mistakes: [], tip: 'Говори больше и смелее.' }); }
});

// ─── ISLAND · TRANSCRIBE (Deepgram — проверка устного английского + субтитры к кружкам) ───
// type:()=>true - iOS шлёт 'video/mp4; codecs=avc1...,mp4a...' с НЕквотированной запятой (невалидный CT),
// стандартный матчер типа кидает исключение и тело молча не читается -> принимаем тело всегда
app.post('/api/island/transcribe', express.raw({ type: () => true, limit: '30mb' }), async (req, res) => {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(503).json({ error: 'no deepgram key' });
  const audio = req.body;
  if (!audio || !audio.length) { console.log('[transcribe] EMPTY body ct=%s', req.headers['content-type'] || '-'); return res.status(400).json({ error: 'no audio' }); }
  const lang = String(req.query.lang || 'en');       // 'en' для проверки английского, 'auto' для кружков (RU и т.п.)
  const ct = req.headers['content-type'] || 'audio/webm';
  const params = new URLSearchParams({ model: 'nova-2', smart_format: 'true', punctuate: 'true' });
  if (lang === 'auto') params.set('detect_language', 'true'); else params.set('language', lang);
  try {
    const r = await fetch('https://api.deepgram.com/v1/listen?' + params.toString(), {
      method: 'POST',
      headers: { Authorization: 'Token ' + key, 'Content-Type': ct },
      body: audio,
    });
    if (!r.ok) { const t = await r.text(); console.error('[transcribe] dg', r.status, t.slice(0, 140)); return res.status(502).json({ error: 'deepgram ' + r.status }); }
    const j = await r.json();
    const ch = j.results && j.results.channels && j.results.channels[0];
    const alt = (ch && ch.alternatives && ch.alternatives[0]) || {};
    const tr = String(alt.transcript || '').trim();
    console.log('[transcribe] bytes=%d ct=%s lang=%s -> "%s" conf=%s', audio.length, ct, lang, tr.slice(0, 80), alt.confidence || 0);
    res.json({ transcript: tr, confidence: alt.confidence || 0, language: (ch && ch.detected_language) || lang });
  } catch (e) {
    console.error('[transcribe]', e.message);
    res.status(500).json({ error: 'transcribe failed' });
  }
});

// ─── FRIENDS ───
app.post('/api/friends/add', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  const friendName = (req.body.friendName || '').toLowerCase().trim();
  if (!friendName || friendName === me) return res.status(400).json({ error: 'bad name' });
  const exists = await pgPool.query('SELECT 1 FROM players WHERE username = $1', [friendName]);
  if (!exists.rows.length) return res.status(404).json({ error: 'no such user' });
  // symmetric — both directions
  await pgPool.query(
    `INSERT INTO friends (user_id, friend_id) VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING`,
    [me, friendName]
  );
  res.json({ ok: true });
});
app.delete('/api/friends/remove', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  const friendName = (req.body.friendName || '').toLowerCase().trim();
  await pgPool.query(
    `DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)`,
    [me, friendName]
  );
  res.json({ ok: true });
});
app.get('/api/friends/list', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  const { rows } = await pgPool.query(
    `SELECT p.username AS name, p.elo, p.wins, p.losses, p.character, p.level, p.last_played
     FROM friends f
     JOIN players p ON p.username = f.friend_id
     WHERE f.user_id = $1
     ORDER BY p.elo DESC`,
    [me]
  );
  const online = onlineSet();
  res.json({ friends: rows.map(r => ({ ...r, online: online.has(r.name) })) });
});

// ─── CLANS ───
app.post('/api/clans/create', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  const tag = (req.body.tag || '').toUpperCase().trim().slice(0, 5);
  const name = (req.body.name || '').trim().slice(0, 32);
  if (!/^[A-Z0-9]{2,5}$/.test(tag)) return res.status(400).json({ error: 'tag must be 2-5 A-Z/0-9 chars' });
  if (!name) return res.status(400).json({ error: 'name required' });
  // is the user already in a clan?
  const inClan = await pgPool.query('SELECT clan_id FROM clan_members WHERE username = $1', [me]);
  if (inClan.rows.length) return res.status(400).json({ error: 'already in a clan — leave first' });
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO clans (tag, name, owner) VALUES ($1, $2, $3) RETURNING *`,
      [tag, name, me]
    );
    const clan = rows[0];
    await pgPool.query(
      `INSERT INTO clan_members (clan_id, username, role) VALUES ($1, $2, 'owner')`,
      [clan.id, me]
    );
    res.json({ clan });
  } catch(e) {
    if (e.code === '23505') res.status(409).json({ error: 'tag already taken' });
    else res.status(500).json({ error: e.message });
  }
});
app.post('/api/clans/join', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  const tag = (req.body.tag || '').toUpperCase().trim();
  const c = await pgPool.query('SELECT id FROM clans WHERE tag = $1', [tag]);
  if (!c.rows.length) return res.status(404).json({ error: 'no clan with that tag' });
  // leave existing first
  await pgPool.query('DELETE FROM clan_members WHERE username = $1', [me]);
  await pgPool.query(
    `INSERT INTO clan_members (clan_id, username, role) VALUES ($1, $2, 'member')`,
    [c.rows[0].id, me]
  );
  res.json({ ok: true });
});
app.post('/api/clans/leave', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  await pgPool.query('DELETE FROM clan_members WHERE username = $1', [me]);
  res.json({ ok: true });
});
app.get('/api/clans/me', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  const { rows } = await pgPool.query(
    `SELECT c.*, cm.role, (SELECT COUNT(*)::int FROM clan_members WHERE clan_id = c.id) AS members
     FROM clan_members cm JOIN clans c ON c.id = cm.clan_id WHERE cm.username = $1`,
    [me]
  );
  res.json({ clan: rows[0] || null });
});
app.get('/api/clans/:tag/members', async (req, res) => {
  const tag = (req.params.tag || '').toUpperCase();
  const { rows } = await pgPool.query(
    `SELECT p.username AS name, p.elo, p.wins, p.losses, p.character, p.level, cm.role
     FROM clan_members cm
     JOIN clans c ON c.id = cm.clan_id
     JOIN players p ON p.username = cm.username
     WHERE c.tag = $1
     ORDER BY cm.role = 'owner' DESC, p.elo DESC`,
    [tag]
  );
  const online = onlineSet();
  res.json({ members: rows.map(r => ({ ...r, online: online.has(r.name) })) });
});
// ─── GLOBAL CHAT (HTTP polling) ───
const lastGlobalMsg = new Map();
app.post('/api/chat/global', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  const text = (req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'empty' });
  const now = Date.now();
  if (now - (lastGlobalMsg.get(me) || 0) < 1500) return res.status(429).json({ error: 'slow' });
  lastGlobalMsg.set(me, now);
  const { rows } = await pgPool.query(
    `INSERT INTO global_messages (username, text) VALUES ($1, $2) RETURNING *`,
    [me, text]
  );
  res.json({ ok: true, message: rows[0] });
});
app.get('/api/chat/global', async (req, res) => {
  if (!pgPool) return res.json({ messages: [] });
  const since = parseInt(req.query.since) || 0;
  const { rows } = await pgPool.query(
    `SELECT id, username, text, created_at FROM global_messages
     WHERE id > $1 ORDER BY id DESC LIMIT 100`,
    [since]
  );
  res.json({ messages: rows.reverse() });
});

// ─── CLAN CHAT (HTTP polling) ───
// Simple rate-limit per user (1 message per 1.5s)
const lastMsgTime = new Map();

app.post('/api/clans/messages', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  const text = (req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'empty' });
  // rate-limit
  const now = Date.now();
  const last = lastMsgTime.get(me) || 0;
  if (now - last < 1500) return res.status(429).json({ error: 'slow down' });
  lastMsgTime.set(me, now);
  // find user's clan
  const cl = await pgPool.query('SELECT clan_id FROM clan_members WHERE username = $1', [me]);
  if (!cl.rows.length) return res.status(403).json({ error: 'not in clan' });
  const clanId = cl.rows[0].clan_id;
  const { rows } = await pgPool.query(
    `INSERT INTO clan_messages (clan_id, username, text) VALUES ($1, $2, $3) RETURNING *`,
    [clanId, me, text]
  );
  res.json({ ok: true, message: rows[0] });
});

app.get('/api/clans/messages', async (req, res) => {
  const me = await authUserFromReq(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  const since = parseInt(req.query.since) || 0;
  const cl = await pgPool.query('SELECT clan_id FROM clan_members WHERE username = $1', [me]);
  if (!cl.rows.length) return res.json({ messages: [] });
  const clanId = cl.rows[0].clan_id;
  const { rows } = await pgPool.query(
    `SELECT id, username, text, created_at
     FROM clan_messages
     WHERE clan_id = $1 AND id > $2
     ORDER BY id DESC LIMIT 100`,
    [clanId, since]
  );
  res.json({ messages: rows.reverse() });   // chronological order
});

app.get('/api/clans/top', async (_, res) => {
  const { rows } = await pgPool.query(
    `SELECT c.id, c.tag, c.name, c.color, c.owner,
       (SELECT COUNT(*)::int FROM clan_members cm WHERE cm.clan_id = c.id) AS members,
       (SELECT COALESCE(SUM(p.elo),0)::int FROM clan_members cm JOIN players p ON p.username = cm.username WHERE cm.clan_id = c.id) AS total_elo
     FROM clans c
     ORDER BY total_elo DESC NULLS LAST
     LIMIT 50`
  );
  res.json({ clans: rows });
});

app.use('/admin', express.static(__dirname + '/admin'));

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// filterBy bracket + code: public rooms match by bracket, private rooms match by code
gameServer.define('fight', FightRoom).filterBy(['mode', 'bracket', 'code']);
gameServer.define('island_lobby', IslandLobby);

const PORT = process.env.PORT || 2567;
(async () => {
  await initDb();
  await loadPhrases();
  await gameServer.listen(PORT);
  console.log(`⚔  Colyseus PvP server listening on :${PORT}`);
})();
