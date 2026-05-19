# Brandon's Birthday Battleship 🍣

A private, two-player online Battleship game for Brandon's 32nd birthday.

## What it is

A small Node.js + WebSocket server that hosts one game between two specific players: **Lucy** and **Brandon**. Each player gets their own private URL and can never see the other's board.

## Deploy to Railway

1. Push these files to a GitHub repo (drag-and-drop in the GitHub web UI works).
2. In Railway: **New Project → Deploy from GitHub Repo → pick this repo**.
3. Railway auto-detects Node.js, runs `npm install`, and starts the server.
4. Once deployed, go to **Settings → Networking → Generate Domain**. You'll get a URL like `something.up.railway.app`.
5. Open the two private links in different browsers (or send one to Brandon):
   - Lucy: `https://YOUR-URL.up.railway.app/?player=lucy`
   - Brandon: `https://YOUR-URL.up.railway.app/?player=brandon`

That's it. Place fleets, take turns, eat sushi.

## Local testing (optional)

```bash
npm install
npm start
# open http://localhost:3000/?player=lucy in one window
# open http://localhost:3000/?player=brandon in another
```

## Notes

- Game state lives in server memory. If Railway restarts the service (rare), the game resets.
- Either player can hit "Rematch" after the game ends to reset.
- No databases, no accounts, no analytics. Just two URLs and some pixel sushi.
