# Discord Activity implementation handoff

Updated: 2026-08-27

## Implemented in the repository

- Activity-only client entry using `@discord/embedded-app-sdk` 2.5.0.
- SDK ready, `identify` authorization, backend exchange, SDK authentication, and backend/SDK user match enforcement.
- Discord participant, layout, thermal, native invite, native external-link, and close adapters.
- Development-only fake Activity platform selected by `npm run dev:activity-test`.
- Backend OAuth exchange, `/users/@me`, and Activity Instance API verification.
- Single-use authorization replay tracking and bounded authentication requests.
- Six-hour signed application sessions using secure iframe cookie attributes.
- One authoritative in-memory room per verified Discord `instanceId`.
- Idempotent join/reload using verified Discord user ID.
- Session-authenticated HTTP and Socket.IO; actors are never accepted from request bodies or socket auth.
- Host-only start, settings, kick, and skip behavior derived from the session.
- Multiple socket presence, reconnect grace, host transfer, spectator rules, chat bounds, and final-room cleanup.
- Discord-native lobby with verified names/avatars and Invite Friends.
- Focused, grid, PIP, safe-area, visibility, and thermal quality behavior.
- Same-origin proxy-safe API/Socket.IO URLs.
- Local Play font and Font Awesome assets; external font/icon CDNs removed.
- Node 24 container/CI, deterministic `npm ci`, environment contract, production config guards, runtime dependency fixes, and built-client secret scanning.
- Automated SDK bootstrap, Discord API, auth/session, instance-room, authority, and Socket.IO tests.

## Local harness

Run:

```powershell
npm run dev:activity-test
```

Then open:

```text
http://localhost:8900/?instance=table-1&user=wizard-1&name=Merlin
```

The harness injects only the Discord-facing identity/SDK boundary. Server sessions, cookies, instance rooms, HTTP authorization, Socket.IO, lobby, and gameplay are the real Activity implementations. Use a different browser profile for a second user because the session cookie is HttpOnly and origin-scoped.

## External steps still required

These cannot be completed from source code without the Discord application owner and deployment credentials:

1. Enable Activities on the chosen development and production Discord applications.
2. Configure User/Guild installs, placeholder OAuth redirect, application bot, Max Participants 6, Web/Desktop platforms, landscape orientation, and the default Launch command.
3. Set `/` URL mappings for the development tunnel, staging host, and production host.
4. Provide server-only secrets through the hosting secret manager.
5. Upload icon, cover, embedded background, screenshots/video, and public Activity metadata.
6. Publish Privacy Policy, Terms of Service, support, and distribution information.
7. Complete a real Discord proxy test with at least two Discord accounts.
8. Complete the six-user staging gate before broader distribution.
9. Keep one server replica until shared authoritative room state and distributed mutation/version control are implemented.

## Real Discord acceptance run

Verify on Discord desktop and web:

1. Launch from the Activity shelf without a redirect or name prompt.
2. Confirm the first user is host and their Discord identity/avatar appears.
3. Use Invite Friends and confirm the invited user auto-joins the same instance.
4. Start a match, submit a word, use both power-ups, chat, skip, and kick.
5. Reload one client and confirm it resumes one player rather than duplicating it.
6. Exercise grid and PIP layouts.
7. Disconnect/reconnect and transfer host by leaving.
8. Confirm another Activity instance has isolated state.
9. Confirm a normal production browser shows the Discord-only launch state and cannot join a room.
10. Inspect Discord Activity logs for CSP, cookie, WebSocket, MIME, or asset failures.

## Release topology

The implemented MVP is single-replica and ephemeral. Deployments or process restarts end active games. Do not increase the replica count until room/game state moves to a shared store with distributed concurrency control; a Socket.IO Redis adapter alone is not sufficient.
