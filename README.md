# `tuesday-proxy` — Tuesday.sh Cloudflare Worker Edge Gateway

Cloudflare Worker Edge Gateway scoped strictly to `api.tuesday.sh/api/v1/*` (Zone `0093c51328b1765e57ee1997f9ad0b05` in Cloudflare Account `a994c7ff6c97fb6120c889c2236cb49b`).

## Route Scoping & Traffic Separation

- **Intercepted by Worker (`api.tuesday.sh/api/v1/*`)**:
  - `POST /api/v1/discovery/analyze` & `POST /api/v1/discovery/confirm`: Full Edge Shield (`X-Tuesday-Device-ID` / Bearer check, `<= 850 KB` payload cap, `30 req/hr` anonymous / `300 req/hr` authenticated sliding-window rate limit, **Tier 0 `$0.00` Gold Catalog Short-Circuit**, and `X-Tuesday-Image-Retention: none_ephemeral_ram_only`).
  - `GET /api/v1/bulletins`, `/api/v1/inventory/*`, `/api/v1/billing/*`: Bot/scraper blocking, CORS preflight handling, and origin forwarding (`X-Tuesday-Edge-Verified: true`).
- **Direct to Origin (`/up`, `/api/up`, `/ping/:token`, `/`, `/users/*`)**:
  - Health checks, router/NAS cron Dead-Man's Switch heartbeats (`/ping/:token`), and browser Devise sessions bypass the Worker route entirely.

## Running Tests

```bash
npm test
```
