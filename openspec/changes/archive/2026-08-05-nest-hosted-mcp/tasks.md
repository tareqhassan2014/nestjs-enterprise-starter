## 1. Schema, permissions, and config

- [x] 1.1 Add Prisma models for API keys (user relation, label, prefix, secret hash, lastUsedAt, revokedAt, timestamps; indexes) and MCP tool invocations (userId, apiKeyId, toolName, outcome, errorCode, requestId, createdAt; indexes); generate and commit migration
- [x] 1.2 Extend `PERMISSIONS` with `api-keys:manage` (and any `mcp:*` permissions chosen for the starter catalog); seed onto baseline `user` / `admin` as designed; ensure `admin` still receives all
- [x] 1.3 Add validated MCP config (`MCP_ENABLED`, `MCP_PATH`, MCP throttle ceilings as needed) + typed namespace; update `.env.example`
- [x] 1.4 Add MCP SDK dependency (`@modelcontextprotocol/sdk` or approved Nest-compatible wrapper) to the workspace

## 2. Agent API keys

- [x] 2.1 Implement API key service: generate prefixed secret, hash at rest, create/list/revoke, prefix lookup + constant-time verify, update lastUsedAt
- [x] 2.2 Implement session-authenticated REST under `/api/v1` for create/list/revoke (enveloped); require `api-keys:manage`; never return hash or plaintext after create
- [x] 2.3 Unit tests: create shows secret once; list omits secret; revoke fails subsequent verify; cross-user revoke denied

## 3. Agent pipeline and principal bridging

- [x] 3.1 Implement Bearer API-key principal resolver that loads the same permission set shape session auth uses
- [x] 3.2 Implement shared `AgentPipeline` (auth → RBAC → plan → throttle → usage → credits → handler) reusing existing domain services; deny before adapter on any stage failure
- [x] 3.3 Unit tests: missing key; missing permission; usage ceiling; insufficient credits; happy path invokes adapter once

## 4. MCP server module

- [x] 4.1 Mount Streamable HTTP MCP transport at configured path; exclude from `/api` prefix and success envelope; honor `MCP_ENABLED`
- [x] 4.2 Implement tool registry with JSON Schemas; register initial read tools (profile, plan, credits balance, ledger page, usage snapshot) as thin adapters to existing services
- [x] 4.3 Expose at least one MCP resource for connection/docs guidance
- [x] 4.4 Wire every tool invocation through `AgentPipeline`; apply Redis MCP throttling

## 5. Audit and metrics

- [x] 5.1 Persist MCP tool invocation rows after authenticated attempts (success / denied / error); no update/delete API
- [x] 5.2 Register Prometheus counters `mcp_tool_invocations_total{tool,outcome}` (no user/key labels); hook from pipeline
- [x] 5.3 Unit/e2e: successful and denied calls write audit + increment metrics; scrape shows series when metrics enabled

## 6. Tests, docs, and wiring

- [x] 6.1 Wire modules into `AppModule` / bootstrap; confirm envelope exclusions for MCP path
- [x] 6.2 E2E: invalid key → unauthorized; valid key lists tools; invoke profile/balance tools; revoked key fails; throttle denial when forced
- [x] 6.3 E2E: if a credit-gated tool exists (or add a test-only gated tool), insufficient credits blocks adapter and does not spend; usage-metered tool shares counters with HTTP when applicable
- [x] 6.4 README: connect from Cursor, Claude, and ChatGPT (URL + Bearer API key); document key management routes, MCP path, non-goals (no session-on-MCP, no second business layer)
