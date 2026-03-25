## Omegle For Your College

This project is a polished Next.js product shell for a campus-only matching app.

### What it includes

- College-only matching
- Verification by college email or campus Wi-Fi token
- B.Tech, dual-degree, M.Tech, MBA, and Ph.D. filters
- Language-first onboarding
- Anonymous-first room design
- Mutual reveal flow instead of forced identity exposure
- Video on/off preference at room start

### Why the product is structured this way

- Google Workspace for Education requires institutions to verify domains and configure MX records, so college identity should be domain-aware.
- Microsoft also provisions institution-owned student accounts through Office 365 Education, so the app cannot assume one universal mail provider.
- IIT Delhi exposes multiple valid domain patterns across official pages, which means production verification should support configured subdomains.
- IIT Bombay and IIT Delhi both show that UG, master, MBA, and doctoral tracks should be filtered differently.

### Getting started

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Notes

- The current implementation is a working frontend shell. It demonstrates the UX, data model, and consent rules without a live backend.
- Productionizing this would require email OTP verification, a campus admin registry, WebRTC/session infrastructure, moderation tooling, and a real Wi-Fi gateway handshake.


