# Words & Wizards Discord Activity

Words & Wizards is a Discord Activity: a multiplayer word game that runs inside Discord using the Embedded App SDK. Players in the same Discord Activity instance share one authoritative server room, spell words on a 5×5 Three.js board, earn gems, and use power-ups.

Discord Activity mode is the only supported product runtime. Browser OAuth, names, public room codes, room browsing, copied web invites, and offline play are not part of the supported application flow.

## Architecture

- `src/activity/` owns the Discord SDK handshake, authorize/authenticate flow, layout/thermal subscriptions, development harness, and Activity UI.
- `src/server/activityAuth.ts` exchanges the single-use OAuth code, resolves `/users/@me`, verifies Activity instance membership, and issues the application session.
- `src/server/activitySession.ts` signs and verifies the short-lived HttpOnly session cookie.
- `src/server/server.ts` keys rooms by verified Discord `instanceId` and derives every HTTP and Socket.IO actor from that session.
- `src/game/SpellcastGame.ts` and `src/game/WordBoard.ts` retain the game presentation and input code.
- `src/shared/rules.ts` remains authoritative for online rules on the server.

The MVP server is intentionally single-replica and keeps active rooms in memory. A restart ends active matches. Shared state and distributed mutation/version control are required before horizontal scaling.

## Requirements

- Node.js 24 LTS
- npm
- A development Discord application with Activities enabled for real Discord testing

Install dependencies with:

```powershell
npm ci
```

## Public landing-page preview

The public website can be previewed without Discord credentials:

```powershell
npm run dev
```

Open [http://localhost:8900](http://localhost:8900). When the four server-only Activity variables are not configured, Vite serves the landing page without starting the authenticated Activity backend. To exercise the game locally, use the test harness below instead.

## Fast local Activity test harness

The harness replaces only the Discord iframe RPC and Discord API verification. It still exercises the Activity bootstrap, server session cookie, instance-scoped room, authenticated HTTP API, authenticated Socket.IO connection, lobby, and game.

```powershell
npm run dev:activity-test
```

Open [http://localhost:8900](http://localhost:8900). The default fake identity is `Test Wizard` in `activity-test-instance-1`.

The harness accepts development-only query parameters:

```text
http://localhost:8900/?instance=table-1&user=wizard-1&name=Merlin
```

- `instance` selects the fake Activity instance.
- `user` selects the fake verified Discord user ID.
- `name` selects the display name.
- `avatar` optionally supplies an encoded HTTP(S) avatar URL for testing the Discord photo treatment.

Use a separate browser profile or private window for a second simultaneous user because the Activity session is stored in an HttpOnly cookie. The Invite Friends button copies a harness URL for the same instance. Both `VITE_ACTIVITY_TEST_MODE` and `ACTIVITY_TEST_MODE` are required, and production startup rejects test mode.

## Real Discord development

Copy `.env.example` to an ignored `.env.local` or configure equivalent environment variables in your shell/hosting platform. Never commit credentials.

Required values:

```dotenv
VITE_DISCORD_CLIENT_ID=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
SESSION_SECRET=
```

`SESSION_SECRET` must contain at least 32 characters. Only `VITE_DISCORD_CLIENT_ID` is included in the browser build.

In the Discord Developer Portal:

1. Enable Activities for the development application.
2. Enable User Install and Guild Install contexts.
3. Add the required placeholder OAuth redirect, such as `https://127.0.0.1`.
4. Create the application bot; its token is required for Activity Instance API verification.
5. Set Max Participants to `6`.
6. Enable Web and Desktop initially.
7. Keep the default `Launch` Entry Point command.

Start the app:

```powershell
npm run dev
```

For recommended proxy testing, run an HTTPS tunnel to port 8900:

```powershell
cloudflared tunnel --url http://localhost:8900
```

In **Activities → URL Mappings**, map `/` to the tunnel hostname without the protocol. Reset temporary mappings when the tunnel is no longer controlled. Launch the Activity from Discord's development Activity shelf; opening the production mode directly in a normal browser is expected to fail the SDK handshake.

The current Discord proxy accepts both `/api/...` and `/.proxy/api/...`; this project uses same-origin `/api/...` and `/socket.io/...` routes under the root mapping.

## Session and network security

- Discord user identity comes from the backend OAuth exchange, never client display data.
- The backend verifies the claimed instance with `GET /applications/{application_id}/activity-instances/{instance_id}` using the application bot token.
- The verified Discord user must appear in the instance's `users` list.
- The application session cookie uses `Secure; HttpOnly; SameSite=None; Partitioned` in production and is scoped to `{clientId}.discordsays.com`.
- HTTP and Socket.IO actions derive user and instance from the session. Client-supplied actor IDs are ignored.
- Production origins are restricted to the application's `discordsays.com` origin plus explicitly configured origins.
- Authorization codes are single-use and additionally replay-tracked for the session window.
- Test mode is rejected whenever `NODE_ENV=production`.

## Native Activity behavior

- Users auto-create or auto-join the room for their verified `instanceId`.
- Discord display names and avatars populate the roster.
- Invite Friends calls Discord's native `openInviteDialog()` command.
- Layout events provide focused, grid, and PIP presentation states.
- Thermal events reduce nonessential visual effects.
- Leaving removes the authenticated player and closes the Activity SDK session.
- Multiple sockets for the same Discord user resume one player record.
- Disconnects receive a five-minute reconnection grace period.

## Build and validation

```powershell
npm run typecheck
npm run test:run
npm run build
npm run verify
```

Production:

```powershell
npm run build
npm start
```

The Docker image builds and runs on Node 24 Alpine and uses `npm ci` for deterministic installation.

## Deployment

Serve the Vite client, `/api/activity/*`, and `/socket.io/*` from one HTTPS host. The host must support WebSocket upgrades. Deploy exactly one replica while rooms remain in memory.

### Railway configuration

Add these service variables in Railway before deploying from `main`:

| Variable | Required | Exposure | Value |
| --- | --- | --- | --- |
| `VITE_DISCORD_CLIENT_ID` | Yes | Public build-time | Discord Application ID. Must match `DISCORD_CLIENT_ID`. |
| `VITE_DISCORD_INSTALL_URL` | No | Public build-time | Optional Discord-provided install-link override. The website otherwise derives the standard link from `VITE_DISCORD_CLIENT_ID`. |
| `DISCORD_CLIENT_ID` | Yes | Server runtime | The same Discord Application ID. |
| `DISCORD_CLIENT_SECRET` | Yes | Secret runtime | OAuth2 client secret from the Discord Developer Portal. |
| `DISCORD_BOT_TOKEN` | Yes | Secret runtime | Bot token used to verify Activity instance membership. |
| `SESSION_SECRET` | Yes | Secret runtime | Random value of at least 32 characters used to sign application sessions. |
| `NODE_ENV` | Recommended | Server runtime | Set to `production`; the Docker image also defaults it to production. |
| `ACTIVITY_ALLOWED_ORIGINS` | No | Server runtime | Comma-separated additional staging or tunnel origins. The production `discordsays.com` origin is added automatically. |

Do not set `ACTIVITY_TEST_MODE` or `VITE_ACTIVITY_TEST_MODE` in Railway. Railway supplies `PORT`; do not hard-code it. The Dockerfile declares only the public `VITE_*` variables as build arguments so Vite can embed them without exposing server secrets. Updating either public variable requires a rebuild.

For the current unlisted rollout, enable **Public Bot**, keep both installation contexts enabled, select **Discord Provided Link**, and leave **Discovery** disabled. The website exposes that direct installation link without listing the Activity in public search. Installation does not bypass Discord's unverified-Activity rule: launching remains limited to approved App Testers and development-team members until Discord verifies the Activity.

Recommended Railway service settings:

- Keep exactly one replica while rooms remain in memory.
- Use `/api/health` as the health-check path.
- Keep the default Dockerfile build and start command.
- Point the `wordsandwizards.app` custom domain at this service and retain WebSocket support.

In the Discord Developer Portal, map Activity prefix `/` to `wordsandwizards.app` without `https://`, enable Activities and the supported platforms, keep the default `Launch` Entry Point command, and configure both User Install and Guild Install contexts. A non-distributed Activity is visible only to the application owner and development team; complete Discord distribution/discovery setup before promising access to all website visitors.

Set all server credentials in the hosting platform secret manager. Before release, verify the built client contains none of `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, or `SESSION_SECRET`, and complete a real proxy session covering invite, two users, gameplay, reconnect, host transfer, and leave.

The remaining Developer Portal, artwork, Privacy Policy, Terms of Service, staging mapping, and distribution steps are tracked in `docs/discord-activity-migration-plan.md`.

## Primary Discord references

- [Building an Activity](https://docs.discord.com/developers/activities/building-an-activity)
- [Embedded App SDK](https://docs.discord.com/developers/developer-tools/embedded-app-sdk)
- [Multiplayer instances](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience)
- [Activity networking and cookies](https://docs.discord.com/developers/activities/development-guides/networking)
- [Local development and URL mappings](https://docs.discord.com/developers/activities/development-guides/local-development)
