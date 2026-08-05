## Why

Agent clients (Cursor, Claude, ChatGPT) increasingly speak MCP, but this starter only exposes Nest HTTP. Forks either skip agent access or bolt on a second business layer that bypasses RBAC, plans, throttling, and credits. A first-party Nest-hosted MCP surface — authenticated for headless agents, wired to existing services, and metered like HTTP — makes the starter agent-ready without forking product rules.

## What Changes

- **Nest-hosted MCP server**: Serve MCP tools and resources from the Nest process (HTTP transport suitable for remote clients), discoverable via a tool catalog with JSON Schema input/output definitions.
- **Agent auth (API key as Bearer)**: User-scoped API keys presented as `Authorization: Bearer <key>`. Keys resolve to the same application principal shape as Better Auth sessions so downstream gates are unchanged. Better Auth cookie sessions are **not** the MCP auth path (awkward for headless agents); session auth remains for the Nest HTTP API and key management UI/API.
- **Thin tool adapters**: Each MCP tool is a thin adapter that calls an existing domain service (credits, subscriptions, account, usage, etc.). No parallel business logic.
- **Same enforcement pipeline**: Every mutating or gated tool invocation runs **auth (API key) → RBAC → plan entitlements → throttle → usage limits → credits** in that order, using existing guards/services.
- **Audit + usage metrics**: Append-only records for which principal / key invoked which tool (success and policy denials where useful); Prometheus counters for MCP tool calls (tool name, outcome class — no unbounded user-id labels).
- **Docs**: README (and/or docs section) for connecting from Cursor, Claude, and ChatGPT with base URL, Bearer header, and example tool discovery.

### Non-goals

- **No second domain/business layer** for MCP — adapters only.
- **No Better Auth session cookies as MCP credentials** in this change (may be revisited later).
- **No OAuth/OIDC dynamic client registration** for MCP hosts in v1 — static user API keys only.
- **No full MCP UI / agent marketplace / multi-tenant org keys.**
- **No rewriting HTTP response envelope rules onto MCP wire format** — MCP uses its own protocol responses; Nest `/api/v1` envelope stays for REST.
- **No shipping every product capability as a tool on day one** — start with a small, useful catalog (account/plan/credits/usage reads + a few safe mutations) and a clear extension pattern.
- **No stdio-only local MCP process** as the primary offering — Nest-hosted remote HTTP is the product; stdio wrappers may be documented as optional client-side helpers only if trivial.

## Capabilities

### New Capabilities

- `mcp-server`: Nest-hosted MCP HTTP transport exposing tools and resources; tool catalog with schemas; thin adapters to existing services; pipeline enforcement on tool calls; connection documentation for major agent clients.
- `agent-api-keys`: User-scoped API keys (create, list, revoke) that authenticate MCP (and optionally other agent) requests via Bearer token and resolve to the existing principal; hashed storage; last-used metadata.

### Modified Capabilities

- `authorization`: MCP tool invocations MUST consume the resolved principal and the same ordered pipeline (RBAC → plan → throttle → usage → credits); extend the permission vocabulary for API key management and any MCP-specific tool permissions as needed.
- `audit-log`: Extend append-only audit (or a dedicated MCP invocation log that operators can query) to record agent tool calls (actor, key id, tool name, outcome, correlation id) without requiring admin-only mutation semantics for every entry.
- `metrics`: Add low-cardinality MCP tool invocation counters (tool name, outcome class) to the existing Prometheus registry.
- `credits`: Clarify that credit-gated MCP tools debit through the existing `CreditService` / spend semantics (idempotency where applicable).
- `usage-limits`: MCP tool calls that map to metered features MUST count toward the same daily/weekly ceilings as equivalent HTTP routes.
- `request-throttling`: MCP transport and/or tool invocations MUST be subject to Redis throttling (default and/or MCP-specific ceilings).
- `data-persistence`: Persist API key records (hashed secret, user relation, metadata); any MCP audit/invocation table if not folded into existing audit log.
- `app-configuration`: Validated env for MCP enablement, mount path, and related limits; document in `.env.example`.

## Impact

**Code**
- New: `mcp` module (transport controller/handler, tool registry, adapters); `agent-api-keys` (or `api-keys`) module + Prisma model; audit/metrics hooks for tool calls.
- Modified: permission catalogue + seed; `AppModule` / bootstrap (MCP path exclusion from Nest envelope / global prefix as designed); config schema + `.env.example`; README connection docs.
- Dependencies: MCP TypeScript SDK (or Nest-compatible MCP server package) pinned in workspace.

**APIs**
- MCP HTTP endpoint(s) outside or beside `/api/v1` as designed (stable path for agent clients).
- Versioned REST for API key lifecycle under `/api/v1` (session-authenticated), enveloped like other Nest routes.

**Auth / billing / credits / throttle**
- MCP: Bearer API key → principal → full commercial pipeline.
- Key management REST: Better Auth session → RBAC (owner manages own keys; admin may list/revoke per policy).
- Tool credit costs and usage feature ids MUST reuse existing catalogues where an HTTP equivalent already exists.
