## Context

The starter already enforces **Auth → RBAC → plan entitlements → throttle → usage limits → credits** on Nest HTTP, with Prisma, Redis, Better Auth sessions, admin monitoring, and Prometheus metrics. Agent clients (Cursor, Claude, ChatGPT) expect **MCP** (tools + resources + JSON Schema discovery), not session-cookie REST alone. There is no API-key principal path today, and no MCP transport in-process.

Constraints: reuse existing domain services; do not duplicate business rules; keep commercial gates ordered and principal-based; secrets only via validated config; MCP wire format is not the Nest success envelope; prefer small reviewable slices.

## Goals / Non-Goals

**Goals:**

- Nest-hosted MCP HTTP transport with a discoverable tool/resource catalog and JSON Schemas.
- User-scoped API keys (`Authorization: Bearer`) as the **only** MCP auth mechanism in this change; resolve to the same principal shape HTTP guards already consume.
- Thin tool adapters → existing services; shared pipeline runner for every gated tool call.
- Audit/usage visibility for which key/user called which tool; low-cardinality Prometheus counters.
- Documented connection steps for Cursor, Claude, and ChatGPT.

**Non-Goals:**

- Better Auth cookie sessions on the MCP channel; OAuth dynamic client registration; org-level keys.
- A parallel domain layer or “MCP-only” credit/usage semantics.
- Shipping every HTTP capability as a tool on day one.
- Enveloping MCP JSON-RPC/stream responses in `{ success, data, error }`.
- Stdio MCP as the primary server mode.

## Decisions

### 1. Transport: Streamable HTTP MCP at a stable non-versioned path

**Choice:** Host MCP via the official TypeScript MCP SDK (or Nest-friendly wrapper around it) using **Streamable HTTP** (current remote MCP transport), mounted at **`/mcp`** (configurable via env). Exclude `/mcp` from the global `/api` prefix and from the Nest success-envelope interceptor — same class of boundary as `/health`, `/api/auth`, `/metrics`.

**Why not** SSE-only legacy transport: Streamable HTTP is the direction MCP clients are standardizing on; document SSE only if the chosen SDK still needs a compatibility shim. **Why not** put MCP under `/api/v1/mcp`: version churn breaks agent configs; protocol versioning belongs in MCP itself. **Why not** a separate Node process: doubles deploy surface and makes sharing Nest DI / Redis / Prisma awkward for a starter.

### 2. Auth: API keys as Bearer — not Better Auth sessions

**Choice:** Agents authenticate with `Authorization: Bearer <api_key>`. Keys are user-owned, created/listed/revoked via session-authenticated REST under `/api/v1/account/api-keys` (or `/api/v1/api-keys`). Store **only a hash** (e.g. SHA-256 or argon2id of the secret) plus a public **prefix** for lookup (`nes_…` / `mcp_…` style). On verify: look up by prefix → constant-time compare hash → attach `{ userId, roles/permissions load path, apiKeyId }` as the request principal.

**Why not** Better Auth session cookies: headless MCP hosts rarely hold browser cookies; cookie `SameSite` and CSRF assumptions do not fit. **Why not** dual session+key on MCP in v1: doubles test matrix and confusing failure modes. **Why not** JWT access tokens alone: keys are revocable rows without building a full OAuth AS; JWTs can be added later if forks need short-lived tokens.

Key management REST stays behind Better Auth session + RBAC (`api-keys:manage` for self; optional admin revoke later).

### 3. Pipeline: shared runner invoked per tool call (not a second Nest guard stack on MCP HTTP)

**Choice:** Nest HTTP guards do not naturally wrap MCP JSON-RPC method dispatch. Implement an **`AgentPipeline`** (name flexible) used by MCP tool handlers:

1. Resolve principal from Bearer API key (fail → MCP auth error).
2. Check tool permission(s) via existing permission vocabulary / role mappings.
3. Plan entitlement (if tool declares a minimum plan / feature).
4. Throttle (Redis; MCP-specific default ceilings + optional per-tool overrides).
5. Usage limits (reuse feature ids from `usage-features` where applicable).
6. Credits spend (reuse catalogue costs / `@Credits` semantics via service call, with idempotency key derived from MCP request id when present).
7. Invoke thin adapter → domain service.
8. Record metrics + invocation audit (success or policy denial after auth).

HTTP routes that already encode these steps remain the source of truth for *product* behavior; the pipeline reuses the **same services** (`Authorization` checks, plan resolution, throttler storage, `UsageLimitsService`, `CreditService`).

**Why not** fake Nest routes per tool just to reuse guards: fragile and fights MCP’s catalog model. **Why not** skip gates “because it’s MCP”: violates AGENTS.md ordering and starter promise.

### 4. Tool registry: declarative catalog + thin adapters

**Choice:** Define tools in a typed registry:

| Field | Purpose |
|-------|---------|
| `name` | MCP tool name (stable, snake or dotted) |
| `description` | Agent-facing summary |
| `inputSchema` / `outputSchema` | JSON Schema for discovery |
| `permissions` | Required permission ids |
| `plan` / `usageFeature` / `creditCost` | Optional commercial metadata |
| `handler` | Adapter calling existing service |

Initial catalog (read-heavy, low risk):

- `account.get_profile` — current user profile
- `plans.get_current` — effective plan / subscription summary
- `credits.get_balance` — wallet balance
- `credits.list_ledger` — recent ledger page (bounded)
- `usage.get_snapshot` — daily/weekly usage for known features

Optional v1 mutation (only if credit/idempotency path is clear): none required for MVP; prefer reads first. Resources MAY expose read-only URIs (e.g. `starter://docs/mcp`) for connection help.

**Why not** auto-generate tools from every controller: noisy, unsafe, and hard to schema. **Why not** a second service layer: proposal forbids it.

### 5. Audit: dedicated MCP invocation log + metrics; admin audit unchanged for admin REST

**Choice:**

- **`McpToolInvocation`** (name flexible): append-only rows — `userId`, `apiKeyId`, `toolName`, `outcome` (`success` | `denied` | `error`), `errorCode` (nullable), `requestId` / MCP correlation id, `createdAt`. No updates/deletes via API.
- Admin list MAY later filter these; for this change, at minimum persist + unit/e2e assert writes. Optional admin read under existing `admin:audit:read` or a new `admin:mcp:read` if separating concerns.
- **Do not** overload `AdminAuditLog` with every tool call (volume + semantics differ from privileged admin mutations).
- **Metrics:** counters `mcp_tool_invocations_total{tool,outcome}` on the existing prom-client registry — **no** `userId` / `apiKeyId` labels.

### 6. Configuration and docs

**Choice:** Validated env, e.g.:

- `MCP_ENABLED` (default true in dev, configurable)
- `MCP_PATH` (default `/mcp`)
- `MCP_THROTTLE_*` (or reuse global throttle with documented MCP tracker keys)

README section: “Connect an MCP client” with Cursor / Claude / ChatGPT config snippets (URL + Bearer header / headers map). `.env.example` documents all vars.

### 7. Package dependency

**Choice:** Add the official `@modelcontextprotocol/sdk` (or current maintained Nest MCP integration if it is a thin SDK wrapper and does not force a second Express app). Prefer one HTTP server (Nest’s) with MCP middleware/controller bridging to the SDK transport.

**Alternatives considered:** Standalone FastMCP/Express sidecar — rejected for starter complexity. Pure custom JSON-RPC without SDK — rejected (discovery/schema drift vs clients).

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| MCP Streamable HTTP / client support still evolving | Pin SDK; document tested clients; keep transport behind `MCP_ENABLED` |
| Pipeline drift vs Nest HTTP guards | Shared services only; e2e tests that same user hits HTTP and MCP and sees same credit/usage effects |
| API key leakage in agent configs / logs | Show secret **once** on create; hash at rest; never log full key; prefix-only in audit |
| High-cardinality metrics | Label by tool name + outcome class only |
| Tool surface becomes an attack/abuse channel | Default throttle + usage + RBAC; start with read-only catalog |
| Envelope interceptor accidentally wraps MCP | Explicit path exclusion in bootstrap (mirror health/metrics) |

## Migration Plan

1. Add Prisma models + migration for API keys and MCP invocation log.
2. Ship key management REST + auth resolver.
3. Enable MCP transport (flagged) with empty/minimal catalog → add tools incrementally.
4. Wire metrics + invocation persistence.
5. Document client connection; add e2e covering auth failure, permission denial, successful tool, and throttle/credit denial where annotated.

**Rollback:** Set `MCP_ENABLED=false`; revoke keys; migration forward-only (tables can remain unused).

## Open Questions

- Exact admin read API for MCP invocations in this change vs defer to a follow-up (lean: persist now, admin list if cheap).
- Whether any mutating tool ships in the first apply slice (lean: reads only).
- Whether API keys may also authenticate selected `/api/v1` routes later (out of scope unless trivial; design keeps resolver reusable).
