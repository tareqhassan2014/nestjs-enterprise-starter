## ADDED Requirements

### Requirement: Credit-gated MCP tools use the existing credit domain

When an MCP tool is declared to cost credits, the MCP pipeline MUST debit the caller’s wallet through the existing credit domain service using the code-declared feature catalogue and integer costs — the same vocabulary as HTTP credit-gated routes.

Spends MUST be idempotent when the MCP request supplies a stable request identifier (or an equivalent derived idempotency key). Insufficient balance MUST deny the tool before the adapter runs, with MCP-level error semantics corresponding to insufficient credits.

Tools without a credit declaration MUST NOT debit the wallet.

#### Scenario: Annotated tool spends once

- **WHEN** a principal with sufficient balance invokes a credit-gated MCP tool
- **THEN** the wallet is debited once via the credit service and the adapter runs

#### Scenario: Insufficient balance blocks adapter

- **WHEN** a principal with insufficient balance invokes a credit-gated MCP tool
- **THEN** no spend is committed and the adapter does not run

#### Scenario: Unannotated tool does not spend

- **WHEN** a principal invokes an MCP tool with no credit declaration
- **THEN** the credit service is not asked to spend for that invocation
