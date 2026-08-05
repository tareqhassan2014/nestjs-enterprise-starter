## ADDED Requirements

### Requirement: Usage-metered MCP tools share feature counters

When an MCP tool is declared against a catalogue usage feature, a successful admission through the usage stage MUST consume the same Redis daily/weekly counters (feature + subject key scheme) as the equivalent HTTP usage-gated path.

Exceeding a ceiling MUST deny the tool before credit spend and before the adapter runs. Tools without a usage declaration MUST NOT increment usage counters.

#### Scenario: MCP consume increments shared counter

- **WHEN** an authenticated principal successfully invokes a usage-metered MCP tool for a catalogue feature
- **THEN** that feature’s user-scoped daily and weekly counters increment as they would for a successful HTTP consume of the same feature

#### Scenario: Ceiling reached denies MCP tool

- **WHEN** the principal’s daily or weekly counter for the feature is already at the ceiling
- **THEN** the MCP tool invocation is denied and the adapter does not run
