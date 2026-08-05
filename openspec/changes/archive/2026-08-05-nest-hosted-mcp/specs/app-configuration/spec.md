## ADDED Requirements

### Requirement: MCP server configuration

The environment schema SHALL declare MCP-related settings, including at minimum: whether MCP is enabled, the mount path (defaulting to a stable non-versioned path such as `/mcp`), and any MCP-specific throttle ceilings that are not inherited solely from global throttle defaults.

Values MUST be exposed through a typed configuration namespace. `.env.example` MUST document each variable.

#### Scenario: Boot with MCP enabled

- **WHEN** the process starts with `MCP_ENABLED=true` (or the schema’s equivalent default) and a valid path
- **THEN** validation passes and the MCP transport can bind on that path

#### Scenario: Invalid MCP path rejected at boot

- **WHEN** the process starts with an MCP path that fails schema validation
- **THEN** the process exits before binding a port and names the offending variable

#### Scenario: Typed MCP config injection

- **WHEN** application code reads MCP settings
- **THEN** it obtains them from the typed MCP configuration namespace rather than `process.env`
