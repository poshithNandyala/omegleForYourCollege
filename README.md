# CampusLink

CampusLink is a college-only video chat and networking app built with React, FastAPI, MongoDB, Socket.IO, and WebRTC.

## Call Features

- Random matching by college, network, or cross-college, with an Omegle-style **Next** button that skips straight into the next match (the skipped peer is auto-requeued too).
- **Screen sharing** on desktop browsers (WebRTC `replaceTrack`, no renegotiation; Daily screen tracks on the fallback provider).
- STUN-first connectivity with an automatic recovery ladder: ICE restart → TURN-only relay rebuild → Daily managed fallback, so strict campus NATs/firewalls still connect.
- Live connection-quality badge (RTT + packet loss via `getStats`) and relay indicator.
- In-call chat with unread counters, AI ice breakers, friend calls, block/report safety tools.

## Local Run

Backend:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8001 --reload
```

Frontend:

```powershell
cd frontend
npm install
npm start
```

## Same-Network Testing

1. Start the backend on `0.0.0.0:8001`.
2. Start the frontend with `HOST=0.0.0.0`.
3. Open the app from another device using `http://<your-laptop-ip>:3000`.
4. The frontend now defaults to `http://<current-browser-host>:8001`, so LAN clients no longer point back to their own `localhost`.
5. Same-network matching is derived from the request IP and, when the browser exposes it, a hashed local subnet fingerprint.

Important:

- For real camera/microphone access on mobile browsers, use HTTPS in anything beyond simple localhost desktop testing.
- STUN-only WebRTC is fine on the same LAN, but production internet calling should use a TURN relay.
- Browsers do not expose the actual WiFi SSID. No pure web app can truthfully read SSID without a native wrapper or managed device agent.

## Production Notes

- Set a strong `JWT_SECRET`.
- Set `COOKIE_SECURE=true` and `COOKIE_SAMESITE=none` behind HTTPS.
- Configure `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`. In `APP_ENV=production`, matching is blocked until TURN is configured.
- Configure `REDIS_URL`. In `APP_ENV=production`, the backend fails startup if Redis is required but unavailable.
- If you deploy behind a reverse proxy, set `TRUST_PROXY_HEADERS=true` so same-WiFi bucketing uses forwarded client IPs.
- Realtime signaling, matchmaking queues, pending matches, online presence, rate limits, reports, and moderation counters can all be shared through Redis.

## Deployment

Recommended setup:

- Frontend static site on Render
- Backend web service on Render
- MongoDB Atlas for the database

Why this fits this repo:

- React builds to static files cleanly.
- FastAPI + Socket.IO runs well as a long-lived web service.
- Render supports Blueprint-based multi-service deploys from a monorepo.

Important production constraint:

- Provision Redis and TURN before launch.
- After Redis is enabled, matchmaking and Socket.IO signaling can run across multiple backend instances.
- The included `render.yaml` provisions a Render Key Value instance and wires its connection string into `REDIS_URL`.

### Render Deploy

This repo includes [render.yaml](/c:/Users/POSHITH/GITHUB/New folder (3)/omegleForYourCollege/render.yaml) for a two-service Render deployment.

1. Push the repo to GitHub.
2. In Render, create a new Blueprint from the repo.
3. During setup, provide secret values for:
   - `MONGO_URL`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
   - `RESEND_API_KEY`
   - `RESEND_FROM`
   - `EMERGENT_LLM_KEY`
   - `TURN_URL`
   - `TURN_USERNAME`
   - `TURN_CREDENTIAL`
   - `CORS_ORIGINS`
4. Create the backend service first or note its public URL.
5. Set frontend `REACT_APP_BACKEND_URL` to your backend URL, for example `https://campuslink-api.onrender.com`.
6. Add your Render-to-Atlas access in MongoDB Atlas Network Access.
7. Redeploy both services after env vars are set.

### Atlas Checklist

- Confirm the cluster is active, not paused.
- Add the source IP/range allowed to connect, or temporarily allow `0.0.0.0/0` only for initial testing.
- Verify the DB user credentials match the `MONGO_URL`.

### Before Real Traffic

- Verify `/api/health` reports `database_connected: true`, `redis_connected: true`, and `turn_enabled: true`.
- Keep moderation collections (`reports`, `blocks`, `moderation_incidents`) monitored from your admin tooling.
- Test calls from different networks, not just the same LAN, before opening access broadly.
