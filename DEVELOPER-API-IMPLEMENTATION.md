# JuanAI Developer API — Implementation

This build provides a server-to-server Developer API for SafariBet and other partner applications. Football and Casino credentials are independent and product-scoped.

## Casino contract

SafariBet uses **only the JuanAI Casino API key + secret**. It must not contain or call JuanAi credentials directly. JuanAI is the upstream adapter and catalogue gateway.

The Casino catalogue is not hard-coded to Aviator/JetX. `GET /api/developer/casino/games` returns JuanAI-owned games plus the complete JuanAi public catalogue discovered from JuanAi providers and pagination. Every JuanAi game has a stable `gameId`, provider, category, image, `source: juanai`, and a JuanAI launch endpoint.

### Implemented Casino endpoints

- `GET /api/developer/casino/providers` — all available JuanAi providers.
- `GET /api/developer/casino/games` — combined JuanAI + JuanAi catalogue.
- `GET /api/developer/casino/all-games` — JuanAi catalogue only.
- `POST /api/developer/casino/launch` — universal JuanAi game launch through JuanAI.
- `POST /api/developer/casino/demo-launch` — backward-compatible alias for launch.
- `GET /api/developer/casino/state/:gameId` — JuanAI-owned game state.
- `GET /api/developer/casino/players/:gameId` — JuanAI-owned game players.
- `GET /api/developer/casino/balance` — JuanAI wallet bridge.
- `POST /api/developer/casino/bet` — JuanAI-owned real-money game bet.
- `GET /api/developer/casino/bet/:betId` — bet result.
- `POST /api/developer/casino/bet/:betId/cashout` — cashout where supported.
- `POST /api/developer/casino/wallet/register` — registers the partner wallet callback base URL.

## JuanAi boundary

The current JuanAi adapter uses the public JuanAi catalogue/server-function transport and public demo launch. Therefore JuanAi games are returned with `launchMode: demo` and `realMoney: false`. This is deliberate: the code must never invent or fake an JuanAi production wallet/session API.

A production real-money JuanAi integration requires authorized JuanAi partner credentials and the provider's production session/wallet/callback contract. Once those are supplied, the same JuanAI Developer API can be extended behind `/casino/launch` without changing SafariBet's key/secret model.

## Authentication

```http
X-JuanAI-Key: jsk_casino_...
X-JuanAI-Secret: jss_casino_...
```

Never expose the secret in SafariBet browser JavaScript. SafariBet's backend sends the credential pair to JuanAI.

## Credential security

- Separate Football and Casino credentials.
- Cryptographically random key/secret generation.
- Secrets stored as scrypt hashes.
- Secret returned only on creation/rotation.
- Product scope enforced on every request.
- Revoked credentials rejected.
- Per-credential rate limiting.

## Admin credential routes

Protected by the existing `X-Admin-Secret` mechanism:

- `POST /internal/developer/credentials`
- `GET /internal/developer/credentials`
- `POST /internal/developer/credentials/:id/revoke`
- `POST /internal/developer/credentials/:id/rotate`

## Rate limiting

The runtime default is 300 requests per 60 seconds per credential. Configure with:

```env
DEVELOPER_API_RATE_LIMIT=300
DEVELOPER_API_RATE_WINDOW_MS=60000
```

## Important production rule

The generic `/casino/wallet/:operation` endpoint intentionally returns a clear `501 PROVIDER_WALLET_NOT_CONFIGURED` response until an authorized upstream production wallet contract is installed. It must not pretend that a public demo endpoint can settle real-money bets.

## Documentation

The documentation is served from `/docs/`.
