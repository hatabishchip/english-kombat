# Рецепт деплоя English Kombat

✅ ПРОВЕРЕНО РАБОТАЕТ 08.08.2026 (выкатка онбординг-воронки Романа).

## Фронт - Vercel, аккаунт English_Combat

```
export VERCEL_TOKEN=$(cat ~/.claude/secure/vercel-english-kombat.token) && vercel deploy --prod --yes --token "$VERCEL_TOKEN" --scope team_yAQstyztFc7eZYKFrqQdtZeJ
```

✅ ПРОВЕРЕНО 27.11.2026. В корне обязан лежать `.vercelignore` белым списком (`/*`, `!/public`, `!/vercel.json`).
Vercel CLI НЕ читает `.gitignore` и без этого файла грузит весь каталог: 27.11.2026 в загрузку пошла `private/`
(195 МБ), выкатка оборвалась на `write EPIPE`. К команде добавлять `< /dev/null`, в логе смотреть размер загрузки
(норма около 1-2 МБ, при правке одного файла десятки КБ). После выкатки проверять состав выкладки:
`GET https://api.vercel.com/v6/deployments/<id>/files?teamId=...` - в `src` только `public` и `vercel.json`. Урок L-40.

Глобальный `vercel whoami` остаётся «Not authorized» - так и надо, глобальную авторизацию CLI не трогаем (правило «один проект = один хостинг-аккаунт»).

## Бэкенд - Contabo, хост `bojra-srv`

```
rsync -az --timeout=60 pvp-server/ bojra-srv:/opt/ekombat-pvp/src/
ssh bojra-srv 'cd /opt/ekombat-pvp && nohup docker compose up -d --build > build.log 2>&1 &'
```

Сборка отсоединённая и переживает смерть чата: 08.08 чат умер от лимита сразу после rsync, сборка сама завершилась через 15 минут и пересоздала контейнер.

## Ловушки

1. **Проверять правку ВНУТРИ контейнера, а не в `/opt/ekombat-pvp/src`.** rsync кладёт исходник мгновенно, но живой контейнер сидит на старом образе, пока не прошла сборка:
   `ssh bojra-srv 'docker exec ekombat-pvp grep -c <маркер> /app/index.js'`
   Путь внутри контейнера - `/app/index.js`, без `src/`.
2. **Имя базы - `english_kombat`**, не `ekombat`: `docker exec ekombat-db psql -U postgres -d english_kombat`.
3. **Время сервера - CEST (UTC+2)**, мак - WITA (UTC+8). Разница 6 часов, при сверке mtime файлов легко ошибиться на «в будущем».

## Проверка после деплоя

Стенд (свой сервер из `public/` + заглушки API): `node qa/run-edge.mjs`, `run-funnel.mjs`, `run-admin.mjs`, `run-server.mjs`.

Живой прогон по проду: `node qa/run-live.mjs` (создан 08.08.2026). Отличия от стенда, которые надо помнить при правках:
- playwright грузится через `loadPlaywright()` из `qa/harness.mjs` (в проекте его нет в `node_modules`);
- состояние игрока читается из `localStorage['ek_island_v1']`, а НЕ из `window.S` (переменная модульная, наружу не торчит);
- живой кружок Романа озвучивается настоящим TTS, поэтому шаг «посмотреть кружок» идёт секундами. `afterCircle` через 14 секунд показывает запасной чип «Дальше 👉». Ходок обязан ждать до 25-30 с и жать этот чип, иначе тест ложно падает на «воронка застряла».
