## MODIFIED Requirements

### Requirement: Feature catalogue and configured ceilings

Feature identifiers used in usage keys MUST come from a code-declared catalogue so callers cannot invent arbitrary unbounded feature strings at runtime without an explicit extension point.

Each feature MUST have configurable daily and weekly ceilings. When the caller has an effective plan with a persisted usage-limit matrix row for that feature, those matrix values MUST be used. Otherwise ceilings MUST come from validated application configuration, with documented defaults suitable for the starter.

#### Scenario: Unknown feature rejected

- **WHEN** application code attempts to consume a feature identifier outside the catalogue
- **THEN** the operation fails as a programming/configuration error rather than silently creating an unbounded counter namespace

#### Scenario: Ceiling from plan matrix

- **WHEN** an entitled user's effective plan defines a daily ceiling for a feature and the user reaches that count
- **THEN** further consumes for that feature that day are rejected at the plan matrix ceiling

#### Scenario: Ceiling from configuration fallback

- **WHEN** no plan matrix row applies for the caller's effective plan and feature, and a feature's daily ceiling is set via configuration
- **THEN** further consumes for that feature that day are rejected at the configured ceiling

## ADDED Requirements

### Requirement: Plan-aware ceiling resolution uses the resolved principal

Usage ceiling resolution for an authenticated consume MUST derive the effective plan from the same subscription/plan rules as the entitlements gate, using the already-known user id on the usage subject, without performing a separate session lookup.

#### Scenario: Pro user gets Pro ceilings

- **WHEN** a user with an entitled Pro subscription consumes a catalogue feature that has distinct Lite and Pro matrix values
- **THEN** the Pro daily and weekly ceilings are applied

#### Scenario: Lite fallback ceilings

- **WHEN** a user with no entitled subscription consumes a catalogue feature
- **THEN** the Lite plan's matrix ceilings apply when present, otherwise configuration defaults
