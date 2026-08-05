# MCP Server

## Purpose

Provide authenticated agents with a Nest-hosted Model Context Protocol server that safely exposes existing application capabilities.

## Requirements

### Requirement: Nest-hosted MCP HTTP transport

The system SHALL expose a Model Context Protocol (MCP) server from the Nest process over Streamable HTTP (or the SDK’s current remote HTTP transport) at a stable, configurable non-versioned path (default `/mcp`).

The MCP path MUST be excluded from the global `/api` prefix and from the Nest success-envelope interceptor. When MCP is disabled via configuration, the path MUST NOT serve an MCP session.

#### Scenario: Enabled MCP accepts protocol traffic

- **WHEN** MCP is enabled and an authenticated agent client opens an MCP HTTP session at the configured path
- **THEN** the server negotiates MCP and exposes the registered tool and resource catalog

#### Scenario: Disabled MCP does not serve the protocol

- **WHEN** MCP is disabled and a client requests the configured MCP path
- **THEN** the response is `404` (or otherwise does not establish an MCP session)

#### Scenario: MCP responses are not success-enveloped

- **WHEN** an MCP protocol response is returned
- **THEN** the body is MCP wire format and is not wrapped in `success` / `data` / `meta`

### Requirement: Tool catalog with JSON Schemas

The system SHALL publish an MCP tool catalog in which each tool has a stable name, human-readable description, and JSON Schema for inputs (and outputs when declared).

Agent clients MUST be able to list tools and obtain schemas through standard MCP discovery without calling a separate proprietary catalog API.

#### Scenario: Tools are discoverable

- **WHEN** an authenticated MCP client lists tools
- **THEN** each registered tool appears with name, description, and input schema

#### Scenario: Unknown tool is rejected

- **WHEN** a client invokes a tool name that is not in the catalog
- **THEN** the invocation fails without executing any domain service

### Requirement: Thin adapters to existing services

Each MCP tool handler SHALL be a thin adapter that calls an existing application domain service. Tool handlers MUST NOT implement a parallel credit ledger, plan resolution, usage counter, or authorization ruleset.

#### Scenario: Profile tool uses account domain

- **WHEN** an authenticated agent invokes the account profile tool
- **THEN** the response data is produced by the existing account/profile domain path (not a duplicated query layer with divergent fields)

#### Scenario: Balance tool uses credit service

- **WHEN** an authenticated agent invokes the credit balance tool
- **THEN** the balance is read through the existing credit domain service

### Requirement: Initial read-oriented tool set

The starter SHALL register at least the following read tools (names may use an equivalent stable naming scheme): account profile, current plan/subscription summary, credit balance, bounded credit ledger page, and usage snapshot for catalogue features.

Mutating tools are optional in the first delivery; when absent, the catalog MUST still be useful for agent inspection of the caller’s commercial state.

#### Scenario: Read tools available after enablement

- **WHEN** MCP is enabled and the catalog is listed
- **THEN** tools covering profile, plan, credits balance, ledger page, and usage snapshot are present

### Requirement: Enforcement pipeline on tool invocation

Every gated MCP tool invocation SHALL run through an ordered pipeline: API-key authentication resolves the principal, then RBAC, then plan entitlements (when declared), then request throttling, then usage limits (when declared), then credit checks (when declared), then the adapter.

Pipeline stages MUST consume the already-resolved principal and MUST NOT perform a separate session lookup. Policy denials MUST prevent the adapter from running.

#### Scenario: Missing credentials denied before adapter

- **WHEN** an MCP tool is invoked without a valid Bearer API key
- **THEN** the invocation is unauthorized and no domain adapter runs

#### Scenario: Missing permission denied before commercial gates

- **WHEN** an authenticated principal lacks a tool’s required permission
- **THEN** the invocation is forbidden and throttle/usage/credit stages are not required to admit the call

#### Scenario: Insufficient credits denied before adapter

- **WHEN** a credit-gated tool is invoked by a principal with insufficient balance
- **THEN** the adapter does not run and no successful spend is committed

### Requirement: Resources for connection guidance

The system SHALL expose at least one MCP resource (or equivalent documented resource) that helps operators or agents locate connection documentation for this server.

#### Scenario: Docs resource is listed

- **WHEN** an authenticated MCP client lists resources
- **THEN** at least one resource related to MCP connection or starter documentation is available

### Requirement: Client connection documentation

The repository SHALL document how to connect Cursor, Claude, and ChatGPT (or their current MCP remote configuration mechanisms) to this server, including the MCP base URL and Bearer API key header requirements.

#### Scenario: README documents three clients

- **WHEN** a contributor opens the project README (or linked docs section for MCP)
- **THEN** it includes connection guidance for Cursor, Claude, and ChatGPT that references the configured MCP path and API key auth
