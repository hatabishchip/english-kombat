# English Kombat — PvP Server

Real-time 1v1 fights via Colyseus framework.

## Деплой на Render (бесплатно, без карты)

### 1. Создай GitHub-репо (если ещё нет)

```bash
cd /Users/oleksandrdiachuk/english-kombat
git init
git add .
git commit -m "init"
# Создай новый репо на github.com (приватный или публичный) и:
git remote add origin git@github.com:USERNAME/english-kombat.git
git push -u origin main
```

### 2. Деплой на Render

1. Открой https://render.com → Sign Up (через GitHub)
2. Dashboard → **New +** → **Web Service**
3. Connect a repository → выбери репо `english-kombat`
4. На странице настроек:
   - **Name**: `english-kombat-pvp`
   - **Region**: Frankfurt (для Европы) или Singapore (для Азии)
   - **Branch**: `main`
   - **Root Directory**: `pvp-server`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Instance Type**: **Free**
5. **Create Web Service**
6. Подожди 2-3 минуты пока соберётся

### 3. Получи URL

После деплоя у тебя будет URL типа `https://english-kombat-pvp.onrender.com`.

### 4. Пропиши в клиенте

Открой `public/index.html`, найди:

```js
const PVP_SERVER_URL = '';
```

Замени на:

```js
const PVP_SERVER_URL = 'wss://english-kombat-pvp.onrender.com';
```

(внимание: `wss://` не `https://` — WebSocket Secure)

### 5. Передеплой Vercel

```bash
cd /Users/oleksandrdiachuk/english-kombat
vercel --prod
```

## Особенности Render Free Tier

- 🌐 750 часов/мес runtime (= одна машина работает 24/7 ~31 день — хватает)
- 💤 **Засыпает через 15 минут неактивности**. Первый PvP-коннект после простоя ждёт 30-60 секунд.
- 🚀 После пробуждения работает мгновенно.
- 💾 512MB RAM, shared CPU — хватает на ~50-100 одновременных боёв.

## Локальная разработка

```bash
cd pvp-server
npm install
npm start
# слушает на ws://localhost:2567
```

Для теста с локального клиента поменяй в index.html на:
```js
const PVP_SERVER_URL = 'ws://localhost:2567';
```

## Мониторинг

Открой `https://english-kombat-pvp.onrender.com/colyseus` — встроенный Colyseus Monitor показывает активные комнаты, игроков, состояние.
