# Mesh Simulation

Interactive simulation of how phones can talk to each other when the network is down: a leaderless group, messages finding their own way, voice, photos, a LoRa radio link between groups, satellite backup, and what happens when signal returns. Built for Smart India Hackathon 2026 by Team ANTIMATTER.

**Live:** https://joythomasl.github.io/mesh_simulation/

## Free play

**Build your own mesh** — drag phones, add phones, drop ESP32 relay boxes, draw walls that block phone links (relays reach over them with LoRa), and send messages to see the path light up.

## Eleven short demos

1. A group of phones with no leader
2. How a message finds its way (hop limit, repeat check)
3. Talking over three phones in between (voice, loss, uneven delay, a cut link)
4. Sending a photo piece by piece (carrying on after a break; why not two paths at once)
5. The LoRa link under India's 2021 rules — G.S.R. 853(E) categories (Table I 1 % vs Table II 10 % access point), adaptive SF and power, compact reports, priority airtime ledger, what is not allowed, licensed spectrum
6. When the gateway phone dies (the radio box picks the next phone)
7. When the radio chain can't reach command (satellite backup, message size limit, clear sky)
8. One phone gets signal, everyone benefits (waiting reports go out in one go)
9. Three ways a warning reaches a dead zone
10. Urgent messages go first (and a broken phone can't hog the SOS lane)
11. A group splits in two, then joins back (clashes are shown, not hidden)

Each demo has controls to play with, live numbers, a log of what happened, and a step-by-step walkthrough. Tick **play by itself** for a hands-off run, or open a demo directly with `#name,auto` (for example `#ptt,auto`).

## Run locally

Static files, no build step: open `index.html`, or `python -m http.server 8000` and visit http://localhost:8000/.

Everything is simulated; the numbers (hop range, 4 open links per phone, LoRa duty cycles from G.S.R. 853(E), 340-byte satellite messages, 2-second heartbeat, …) are the ones from the design.
