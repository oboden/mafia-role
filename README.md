# Mafia Role Dealer

The game master sets how many players, Mafia and Doctors there are and shows a QR code.
Each player scans it on their phone, types their name, and taps to reveal a secret role.
The game master's screen lists every name with its role (hidden until they tap **Show roles**).

## Play on your Wi-Fi (no hosting needed)

You need [Node.js](https://nodejs.org) 18 or newer on the game master's laptop.

```
npm install
npm start
```

Open http://localhost:3000 on that laptop and create a game. The QR code automatically points
phones at the laptop's Wi-Fi address, so players must be on the same Wi-Fi network.
If phones can't load the page, the laptop's firewall is blocking port 3000: allow Node through
it when your computer asks. Some guest or office networks block devices from reaching each other;
use a phone hotspot or host it online instead.

## Host it online for free (any network, game master can use a phone)

1. Put this folder in a GitHub repository (leave out `node_modules` and `data`).
2. On [render.com](https://render.com), choose **New > Web Service**, pick the repo, and set
   Build command `npm install`, Start command `npm start`, Instance type **Free**.
3. Open the `onrender.com` address Render gives you and create a game.

Free Render services go to sleep after about 15 minutes without visitors, and the first visit
after that takes up to a minute to wake. Open the site a minute before you play. A sleep or
redeploy also wipes any game in progress, so just create a new one.

## How it behaves

- Roles are shuffled and each one is dealt exactly once. Default Mafia count is 1 per 4 players.
- Extra scans beyond the player count are refused with a message.
- A phone that refreshes or re-scans gets the same role back.
- Two players can't use the same name.
- **Remove** puts that player's role back in the deck for someone else to scan.
- **Deal a new round** reshuffles everything; open phones get a one-tap button for their new role.
- Optional: Mafia players see who the other Mafia are.
- Games are forgotten after 12 hours of inactivity.

## Test

With the server running: `BASE=http://localhost:3000 node test/e2e.js` (needs `npm i -D playwright`).
