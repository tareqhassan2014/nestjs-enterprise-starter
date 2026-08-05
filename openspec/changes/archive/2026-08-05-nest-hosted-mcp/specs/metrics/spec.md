## ADDED Requirements

### Requirement: MCP tool invocation metrics

The system SHALL register Prometheus counters for MCP tool invocations labeled by tool name and outcome class (`success`, `denied`, `error`, or an equivalent small closed set).

Metric label sets MUST NOT include user id, API key id, email, or other unbounded subject identifiers.

#### Scenario: Successful invocation increments counter

- **WHEN** an authenticated agent successfully invokes a tool
- **THEN** the MCP tool invocation metric reflects an additional observation for that tool name and success outcome

#### Scenario: Denied invocation increments counter

- **WHEN** an authenticated agent is denied a tool for RBAC, plan, throttle, usage, or credits
- **THEN** the metric reflects an additional observation for that tool name and a denied (or equivalent) outcome

#### Scenario: No subject labels on MCP metrics

- **WHEN** the registered MCP metric label names are inspected
- **THEN** they do not include `userId`, `apiKeyId`, `email`, or equivalent high-cardinality subject identifiers
