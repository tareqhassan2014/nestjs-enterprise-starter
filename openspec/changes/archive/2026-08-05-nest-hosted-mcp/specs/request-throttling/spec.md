## ADDED Requirements

### Requirement: MCP transport and tool invocations are throttled

MCP HTTP traffic and/or per-tool invocations SHALL be subject to Redis-backed burst and per-minute throttling using the shared Redis client. Ceilings MUST come from validated configuration (global defaults and/or MCP-specific overrides).

When a ceiling is exceeded, the tool adapter MUST NOT run and the client MUST receive a rate-limit denial in MCP error form (HTTP `429` on the transport is acceptable where the transport surfaces it).

The MCP path MUST NOT be entirely exempt from throttling while enabled, except for explicitly documented health-style probes unrelated to tool execution.

#### Scenario: Within MCP limits

- **WHEN** an authenticated agent invokes tools under the configured MCP burst and per-minute ceilings
- **THEN** permitted tools proceed past the throttle stage

#### Scenario: MCP burst exceeded

- **WHEN** an agent exceeds the MCP burst ceiling within its window
- **THEN** further tool invocations are denied as rate limited and adapters do not run

#### Scenario: Limits shared across instances

- **WHEN** two application instances share Redis and an agent splits MCP calls across both until the combined count exceeds a limit
- **THEN** further invocations are rate-limited regardless of which instance receives them
