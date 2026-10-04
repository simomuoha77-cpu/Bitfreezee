# AS Tech public catalogue feed -> JuanAi -> SafariBet

This integration does **not** use AS Tech partner API credentials.

JuanAi reads the catalogue/demo data exposed by AS Tech's public provider site through its public TanStack Start server functions. SafariBet never connects to AS Tech directly.

## Architecture

```text
AS Tech public catalogue
        |
        v
     JuanAi
        |
        v
    SafariBet
```

## Discovered public server functions

```text
GET  4058c0a01256721ebfb8fa103ec7917336474914f990ef66230f709ac989a634
POST f07c6f8a5a9fb9b1114ce81637d1c2d65e808d67e9b4b5dcefca426d32f51ed6
POST 4ab17f09ba48ede6e014c5e622114a0b00c72cab6878df37e1fdf2fd33551fca
```

The games function receives:

```json
{
  "data": {
    "providerCode": "spribe",
    "search": "",
    "page": 1
  }
}
```

The demo launch function receives:

```json
{
  "data": {
    "gameId": "spribe:737"
  }
}
```

These are the public functions used by AS Tech's own provider pages. TanStack Start documents server functions as same-origin RPC endpoints; this adapter does not attempt to bypass AS Tech authentication or CSRF controls. If AS Tech stops accepting server-to-server catalogue calls, the adapter should fall back to the public provider HTML or use authorized partner credentials instead.

## Environment

```env
AS_TECH_BASE_URL=https://astechapi.cloud
AS_TECH_SERVER_FN_BASE=/_serverFn/
AS_TECH_TIMEOUT_MS=15000
AS_TECH_CACHE_MS=300000
AS_TECH_MAX_PAGE=1000
```

There is deliberately **no** `AS_TECH_API_KEY` or `AS_TECH_API_SECRET` in this mode.

## JuanAi endpoints

All endpoints below still require the JuanAi `jsk_...` API key.

```text
GET  /api/casino/as-tech/providers
GET  /api/casino/as-tech/games?providerCode=spribe&page=1
GET  /api/casino/as-tech/all-games
POST /api/casino/as-tech/demo-launch
```

The existing endpoint can also select the source:

```text
GET /api/casino/games?source=as-tech
GET /api/casino/games?source=as-tech&providerCode=spribe
```

## Important real-money boundary

AS Tech's public site advertises zero-balance demo launches, but its production integration requires partner credentials, HMAC signing and wallet callbacks. This adapter does **not** turn the public demo into a real-money integration.

For real-money AS Tech games, obtain authorized sandbox/production credentials from AS Tech and implement their documented `/api/public/v1/session/open` and seamless-wallet callback contract separately.
