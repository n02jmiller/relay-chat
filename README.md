# Relay

A real-time chat app with account registration, direct and group messages, paginated history, presence, one-to-one voice/video calls, and installable PWA support.

## Run locally

- Install Node.js 20 or newer.
- Run `npm install`, then `npm run dev`.
- Open the Vite URL shown in the terminal (usually http://localhost:5173).
- Create accounts in two browser profiles or devices to test messaging and calls.
- Scroll to the top of a conversation to fetch older messages; use the `+` inbox button to create a group.
- On a supported browser, use the download icon in the inbox to install Relay. On iOS, use Safari's Share menu and choose **Add to Home Screen**.
- Use the phone or video icon in a direct conversation to start a call. Calls require microphone permission; video calls also require camera permission.

The API and Socket.IO server run on port 3001. Local development uses `server/data.json`; setting `DATABASE_URL` switches accounts, groups, and messages to PostgreSQL. Voice calls need microphone permission; video also needs camera permission. For devices on a network or a deployed app, serve the app over HTTPS and configure a TURN server for reliable direct calls across restrictive networks. The included STUN configuration is suitable for development, not every production network.

## Deploy publicly

This project includes a Render Blueprint in `render.yaml`. To publish it:

1. Push this project to a GitHub repository.
2. In Render, choose **New** then **Blueprint**, and connect the repository.
3. Review the service and persistent disk, then create the Blueprint.
4. When the deployment finishes, open the `onrender.com` URL shown for the service. That HTTPS URL is the public site; share it so others can create accounts and chat.

The blueprint runs the frontend, API, and Socket.IO signaling on one public service. It generates a stable token-signing secret. On Render's free plan, the service sleeps when idle and its local JSON data can be lost when the service restarts. To keep accounts and messages on the free plan, create a free PostgreSQL database (for example at [Neon](https://neon.tech/)), copy its pooled connection string, and add it to the Render service as the secret environment variable `DATABASE_URL`. Save the change and redeploy. The `/api/health` response reports `persistentStorage: true` when PostgreSQL is connected. Without `DATABASE_URL`, the server deliberately falls back to local JSON and data can disappear on a restart. The JSON snapshot adapter is intended for a small single-instance demo; for larger traffic, migrate to normalized PostgreSQL tables and use a shared Socket.IO adapter.

Direct calls require microphone permission; video calls also require camera permission. Group video uses Jitsi Meet, a third-party service; members are invited through Relay, but anyone with the random room URL could join. HTTPS is provided by Render. Direct calls between restrictive networks may need a TURN service; the current app uses a public STUN server only. Never commit production secrets to the repository.
