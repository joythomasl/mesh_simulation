# RescueLINK — Mesh Simulation

Interactive simulation of how RescueLINK's phones talk to each other when the network is down. Companion to the [RescueLINK command console](https://github.com/joythomasl/RescueLINK). Built for Smart India Hackathon 2026 (SIH26206) by Team ANTIMATTER.

**Live:** https://joythomasl.github.io/mesh_simulation/

## Eleven short demos

1. A group of phones with no leader
2. How a message finds its way (hop limit, repeat check)
3. Talking over three phones in between (voice, loss, uneven delay, a cut link)
4. Sending a photo piece by piece (carrying on after a break; why not two paths at once)
5. The LoRa link: slow, so use it carefully (air time, range setting, SOS first)
6. When the gateway phone dies (the radio box picks the next phone)
7. When the radio chain can't reach command (satellite backup, message size limit, clear sky)
8. One phone gets signal, everyone benefits (waiting reports go out in one go)
9. Three ways a warning reaches a dead zone
10. Urgent messages go first (and a broken phone can't hog the SOS lane)
11. A group splits in two, then joins back (clashes are shown, not hidden)

Each demo has controls to play with, live numbers, a log of what happened, and a step-by-step walkthrough. Tick **play by itself** for a hands-off run, or open a demo directly with `#name,auto` (for example `#ptt,auto`).

## Run locally

Static files, no build step: open `index.html`, or `python -m http.server 8000` and visit http://localhost:8000/.

Everything is simulated; the numbers (hop range, 4 open links per phone, 1 % LoRa air time, 340-byte satellite messages, 2-second heartbeat, …) are the ones from the design.
