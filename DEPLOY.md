# Deploy the Dynasty Ticker to the cloud (no coding)

This puts your ticker online 24/7 so weekly tracking catches everyone, even when your own computer is off. We'll use **Railway** because it doesn't fall asleep like most free tiers and the setup is the most click-friendly. Plan on about 20 minutes the first time.

You'll do three things: put the code on GitHub, point Railway at it, and paste in your settings. Your Twitch keys go into Railway directly, not into any file.

---

## Part 1 — Put the code on GitHub

GitHub is just where the files live so Railway can grab them.

1. Make a free account at https://github.com if you don't have one.
2. Go to https://github.com/new to create a new repository. Name it `dynasty-ticker`. Leave everything else default. Set it to **Private** if you like. Click **Create repository**.
3. On the next page, click the link **"uploading an existing file"** (in the line "…or push an existing repository / uploading an existing file").
4. Open the `dynasty-ticker` folder on your computer, select **all the files inside it** (server.js, package.json, members.json, schedule.json, the `public` folder, README.md, etc.), and drag them into the browser upload box.
   - Do **not** worry about `node_modules`, `.env`, or `sessions.json`. If you see them, leave them out. The app rebuilds those automatically, and your keys should not go on GitHub.
5. Click **Commit changes**. Your code is now on GitHub.

---

## Part 2 — Connect Railway

1. Go to https://railway.app and click **Login**, then **Login with GitHub**. Approve the access it asks for.
2. Click **New Project** → **Deploy from GitHub repo** → pick your `dynasty-ticker` repo.
3. Railway reads the project and starts building automatically. Give it a minute. It knows how to run it (`npm install` then `node server.js`) because the project is already set up for that.

---

## Part 3 — Paste in your settings (this is where your Twitch keys go)

1. Click your service (the box named dynasty-ticker), then open the **Variables** tab.
2. Add these one at a time (name on the left, value on the right):

   | Name | Value |
   |------|-------|
   | `TWITCH_CLIENT_ID` | *your Twitch Client ID* |
   | `TWITCH_CLIENT_SECRET` | *your Twitch Client Secret* |
   | `DYNASTY_GAME_NAME` | `EA Sports College Football 27` |
   | `POLL_SECONDS` | `45` |
   | `DATA_DIR` | `/data` |

3. Railway will redeploy after you add variables. That's normal.

---

## Part 4 — Keep your weekly history (add a volume)

Without this, the weekly activity log resets every time Railway restarts. This fixes that.

1. In your service, find **Settings** (or right-click the service) → **Add Volume**.
2. Set the **Mount path** to `/data` (matches the `DATA_DIR` you set above).
3. Save. That folder now survives restarts, so your season's activity is preserved.

---

## Part 5 — Get your link and open it

1. In the service, open **Settings** → **Networking** → click **Generate Domain**.
2. Railway gives you a public URL like `dynasty-ticker-production.up.railway.app`.
3. Open it. Your live ticker is online. Share that link with the whole dynasty; anyone can open it, no login.

---

## Keeping it updated later

- **Change the roster or schedule:** edit `members.json` or `schedule.json` on GitHub (open the file → pencil icon → edit → Commit). Railway auto-redeploys within a minute. No computer setup needed.
- **New week:** just bump the `week` number in `schedule.json` and update the matchups.
- **New season:** delete `sessions.json` from the volume to reset activity history (ask me and I'll show you how, or I can add a reset button).

## Cost note

Railway gives a monthly free usage credit. A tiny always-on app like this that just polls Twitch is very light, but it is usage-based, so glance at your usage now and then. If you'd rather have a hard $0 option, tell me and I'll walk you through Render's free tier instead (the tradeoff is it sleeps when idle, which weakens weekly tracking).

## If you get stuck

Tell me which part number you're on and what you see on screen. I can also switch the whole thing to run on your own computer instead if the cloud steps feel like too much.
