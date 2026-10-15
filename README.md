# The Mafia Daily

A host's companion for in-person Mafia. The host sets how many players, Mafia and Doctors there
are and shows a QR code. Each player scans it, types their name, and presses and holds to see a
secret role. Then the host runs the whole game from their phone: night, the morning paper, the
day's trials and votes, and the final edition.

**The phones record the game; the room plays it.** Mafia still point silently, accusations happen
out loud and votes are a show of hands. Only the host taps what happened. Player phones stay face
down apart from peeking at their role, a "you're out" screen, and the final results.

## How a game runs

1. **Lobby.** Players scan and get roles. The host can start once at least 3 are in; anyone who
   hasn't scanned sits that game out.
2. **Night.** The host's screen goes dark and walks through it step by step, with a line to read
   aloud at each step: everyone sleeps, the Mafia wake and point (the host taps who), the Doctor
   wakes and points, everyone wakes. If the Doctor is already out, the screen still tells the host
   to read the Doctor's line so nobody can tell.
3. **Morning paper.** A front page says who died (or that the Doctor saved them, or a quiet
   night). The host reads it aloud.
4. **Day.** Optional discussion timer (2, 3 or 5 minutes). The host taps who's on trial, the table
   votes by hands, and the host taps **Voted out** or **Spared**. Spared players can be tried again
   or the day can end without a vote.
5. **Obituary**, then night falls again.
6. **Final edition** when the Mafia are all out (town wins) or match everyone else (Mafia win).
   Every phone shows who was who.

Every step has **Undo** in case the host taps the wrong person in the dark.

Setup options: Mafia can see each other; reveal a player's role when they're out (on by default).

## Feedback: letters to the editor

When a game ends, every phone (host included) shows a 30-second form: would you play again, what
slowed the game down, where the app got in the way, and anything you wish it did. The host sees
every letter on their final screen and can **Copy all**.

Free hosting forgets games when it sleeps, so copy the letters the same night. To keep them
permanently, set the environment variable `FEEDBACK_WEBHOOK` to any URL that accepts JSON (a
Discord or Slack webhook, a Google Apps Script, Formspree...). Each letter is posted there as it
arrives.

## Illustrations

The front page and the role cards have empty, framed slots. Drop artwork into
`public/illustrations/` and it fills them automatically:

- **Front page:** `cover.mp4` or `cover.webm` (a short muted loop, so the photo moves),
  or `cover.gif`, `.webp`, `.png`, `.jpg`. Portrait 4:5. A still image gets a slow drift and a
  film flicker.
- **Role cards:** `mafia.png`, `doctor.png`, `villager.png` (square; `.webp`, `.gif`, `.svg`,
  `.jpg` also work).

## The reveal

A player presses and holds their card. For 1.2 seconds a ring fills, the card trembles harder,
a neutral glow grows, a build-up sound rises and (on Android) the phone buzzes faster and faster.
Then the card opens with a soft halo behind it in the role's colour, a reveal sound, and the
role's own vibration. Letting go at any point hides it again and stops everything.

The host can switch off, per game: **vibration**, **role-coloured glow** (then every card gets
the same neutral halo) and **sound**.

- **Sound:** put `buildup.mp3` and `reveal.mp3` (or `.m4a`, `.ogg`, `.wav`) in `public/sounds/`.
  Every role hears exactly the same two sounds. Until the files exist, quiet placeholder tones
  play. This repo is public, so only add sounds whose licence allows sharing the file itself
  (CC0 is safest: Kenney.nl, or Freesound filtered to CC0).
- **Vibration:** the build-up pattern is the same for every role. The reveal patterns are in
  `PATTERNS` in `public/common.js`; keep them the same total length and amount of buzzing or
  neighbours can hear who's who (the browser test warns if they differ). iPhones can't vibrate
  from a website at all, so on iPhone the sound and the on-screen build-up do that job.

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

## How dealing behaves

- Roles are shuffled and each one is dealt exactly once. Default Mafia count is 1 per 4 players.
- Extra scans beyond the player count are refused with a message; so are scans after the game starts.
- A phone that refreshes or re-scans gets the same role back.
- Two players can't use the same name.
- **Remove** (lobby only) puts that player's role back in the deck for someone else to scan.
- **Deal a new round** / **Play again** reshuffles everything; open phones get a button for their new role.
- Every role card looks the same from across the table: only the words change, never the colour.
- Games are forgotten after 12 hours of inactivity.

## Test

- Game rules, no browser needed: `node test/api.js`
- Whole games in real browsers, with the server running:
  `BASE=http://localhost:3000 node test/e2e.js` (needs `npm i -D playwright`).
  Add `SHOTS=shots` to save a screenshot of every screen.

Fonts are bundled in `public/fonts` (Fraunces, DM Sans, Courier Prime, UnifrakturMaguntia; SIL
Open Font License) so Wi-Fi games with no internet still look right.
