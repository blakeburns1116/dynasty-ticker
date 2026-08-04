# 🏈 Dynasty Ticker

A live Twitch board plus weekly activity tracker for your NCAA 27 dynasty. It shows who's streaming the dynasty right now, rolls up who has and hasn't played each week, and infers matchup progress from your slate.

## What it does

**Live now** — polls the Twitch API every ~45 seconds and shows which of your members are streaming, what game, stream title, viewers, and how long they've been live. Members playing the dynasty are highlighted green; members streaming something else show dimmed so you can tell real dynasty action from someone just chatting.

**Weekly activity** — every time it sees a member live on the dynasty, it logs the session. That builds a weekly table: who played, session count, total time on the dynasty, and last seen. Members who haven't played yet are flagged so you can nudge them.

**Schedule** — you enter the week's matchups; the board marks a game "likely played" once both coaches have streamed that week. User vs CPU games count once the human streams.

## One-time setup (about 10 minutes)

1. **Install Node.js** (v18 or newer) from nodejs.org if you don't have it.

2. **Register a free Twitch app** at https://dev.twitch.tv/console/apps → "Register Your Application". Name it anything, set OAuth Redirect URL to `http://localhost`, category "Application Integration". After creating, copy the **Client ID** and generate a **Client Secret**.

3. **Configure.** In this folder, copy `.env.example` to `.env` and paste in your Client ID and Secret.

4. **Add your members.** Edit `members.json` — one entry per coach with their exact Twitch login (the name in `twitch.tv/NAME`, lowercase), their coach name, and school.

5. **Set the week.** Edit `schedule.json` with the current in-game week and matchups.

## Run it

```
npm install
npm start
```

Then open http://localhost:3000.

Want to see it work before touching any of the config? Run `npm run mock` — it serves fake live data so you can see the whole thing immediately, no Twitch keys needed.

## Keeping it always-on (for real weekly tracking)

The weekly tracker only logs while the app is running, so for it to catch everyone you'll want it up 24/7 during the week. Easiest options:

- **A cheap always-on box** you already have (a home server, Raspberry Pi, an old laptop). Run `npm start` and leave it.
- **A free/cheap host** like Railway, Render, or Fly.io. Push this folder, set the same environment variables from `.env`, and it runs continuously. Note: `sessions.json` is the activity log — on hosts with ephemeral disks, attach a small persistent volume or swap the JSON store for a hosted database so weekly history survives restarts.

## How the data works

`sessions.json` is created automatically the first time a member is seen live on the dynasty. It's the source for the weekly rollup. Delete it to reset history (e.g., at the start of a new season). It's plain JSON, so you can inspect or back it up easily.

## Twitch specifics

The app authenticates with a Twitch **app access token** (client-credentials), which is why it needs the Client Secret and must run server-side rather than purely in the browser. Polling ~25 usernames every 45 seconds sits far under Twitch's rate limits. The game filter matches the exact category name Twitch uses; confirm it's labeled `EA Sports College Football 27` on Twitch and adjust `DYNASTY_GAME_NAME` in `.env` if they rename it.

## Optional next step: read Discord instead of / alongside Twitch

Your Discord already fires "so-and-so is live" notifications, which means the members and their streams are already mapped there. A Discord bot could read that channel to log activity as a backup to Twitch polling (useful for anyone who plays but doesn't stream). That's a natural follow-on: add a bot token, have it watch the notifications channel, and write into the same `sessions.json`. Ask and I'll build it.

## Files

- `server.js` — the service: Twitch polling, session logging, weekly rollup, web + API
- `public/index.html` — the ticker page (Live / Weekly / Schedule tabs)
- `members.json` — your roster
- `schedule.json` — the current week's matchups
- `.env.example` — copy to `.env` and fill in Twitch keys
- `sessions.json` — auto-created activity log
