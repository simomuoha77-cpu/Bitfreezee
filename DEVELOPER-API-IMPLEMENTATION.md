# JuanAi Developer API — Implementation

This build adds a product-scoped Developer API without replacing the existing JuanAi football, casino or AS Tech integrations.

## Credentials

- Football and Casino credentials are separate MongoDB records.
- API keys and secrets are generated with cryptographically secure randomness.
- Secrets are stored as scrypt hashes and are returned only on creation/rotation.
- Credentials can be listed, revoked and rotated through admin-protected routes.
- Product scope is enforced server-side.

## Developer API routes

### Football

- `GET /api/developer/football/fixtures`
- `GET /api/developer/football/competitions`

### Casino

- `GET /api/developer/casino/providers`
- `GET /api/developer/casino/games`
- `GET /api/developer/casino/all-games`
- `POST /api/developer/casino/demo-launch`

The Casino routes call the existing AS Tech public catalogue/demo adapter. They do not expose AS Tech credentials or internal provider authentication.

Production wallet endpoints are intentionally not faked. The current wallet bridge remains intact; production Developer API wallet operations are pending a real transaction/callback implementation.

## Authentication

```http
X-JuanAI-Key: jsk_football_...
X-JuanAI-Secret: jss_football_...
```

Use the corresponding Casino pair for Casino routes.

## Admin routes

Protected by the existing `X-Admin-Secret` mechanism:

- `POST /internal/developer/credentials`
- `GET /internal/developer/credentials`
- `POST /internal/developer/credentials/:id/revoke`
- `POST /internal/developer/credentials/:id/rotate`

## Rate limiting

The default Developer API limit is 120 requests per 60 seconds per credential. Configure:

```env
DEVELOPER_API_RATE_LIMIT=120
DEVELOPER_API_RATE_WINDOW_MS=60000
```

## Documentation

The verified documentation is served from `/docs/` and links to the actual implemented Developer API routes. No unimplemented `/api/v1/*` routes are advertised.
