# AS Tech backend feed -> JuanAi -> SafariBet

This integration is specifically for the situation where JuanAI does **not** have AS Tech partner API credentials. It uses the same public TanStack Start server-function mechanism already used by the AS Tech provider site for catalogue data.

JuanAI reads the complete dynamically available AS Tech catalogue through AS Tech's existing TanStack Start server-function/backend feed. SafariBet never connects to AS Tech directly; it consumes JuanAI.

## Architecture

```text
AS Tech existing backend/server-function catalogue feed
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

The catalogue games function receives:

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

## Launch and real-money boundary

The existing AS Tech backend function discovered in this project provides the public launch flow. The current function is documented by the adapter as a **demo/public launch**, so JuanAI must not label it as a production real-money session.

The catalogue itself is dynamic and includes all providers/games returned by the AS Tech backend feed; it is not restricted to Aviator or JetX.

If AS Tech's backend later exposes an authorized production session through this same mechanism, that exact mechanism can be added without inventing an API key/secret. Until then, JuanAI must fail honestly rather than pretending a demo URL is a real-money wallet session.
