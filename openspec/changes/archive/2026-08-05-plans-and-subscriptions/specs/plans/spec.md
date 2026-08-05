## ADDED Requirements

### Requirement: Plan catalogue with Lite, Pro, and optional Enterprise

The system SHALL persist a catalogue of commercial plans identified by stable slugs. The starter catalogue MUST include `lite` and `pro`, and MUST include `enterprise` as an optional higher tier that forks may hide by deactivating without removing the row.

Each plan MUST carry a display name, a numeric rank for ordering and minimum-plan checks, and an active flag. Plan rows MUST be unique by slug.

#### Scenario: Starter plans present after seed

- **WHEN** the seed command completes against a migrated database
- **THEN** plans with slugs `lite`, `pro`, and `enterprise` exist

#### Scenario: Slug uniqueness

- **WHEN** a second plan is inserted with an existing slug
- **THEN** the database rejects the duplicate

#### Scenario: Inactive enterprise still addressable by slug

- **WHEN** the `enterprise` plan's active flag is set to false
- **THEN** existing subscriptions that reference it remain valid for resolution, and the plan is omitted from any public active-catalogue listing if one exists

### Requirement: Entitlement vocabulary is declared in code

The set of entitlement identifiers SHALL be declared in code as the single source of the vocabulary. Route annotations and service checks SHALL be typed against that declaration so an unknown identifier is a compile-time error.

Per-plan entitlement values SHALL be persisted as boolean flags keyed by plan and entitlement identifier. Seeding MUST upsert a row for every declared entitlement on every seeded plan. A persisted entitlement key absent from the code declaration MUST have no effect on any decision.

#### Scenario: Misspelled entitlement in an annotation

- **WHEN** a route annotation names an entitlement identifier that is not in the declared set
- **THEN** the type check fails and the project does not build

#### Scenario: Seed covers the catalogue

- **WHEN** the seed completes
- **THEN** every seeded plan has a boolean entitlement row for every declared entitlement identifier

#### Scenario: Orphan entitlement row

- **WHEN** a plan entitlement row uses a key that no declaration names
- **THEN** no gate or resolution decision changes because of that row

### Requirement: Per-plan usage limit matrices

The system SHALL persist daily and weekly usage ceilings per plan for each usage-feature identifier in the code-declared usage catalogue.

Matrix values MUST be positive integers. Ceilings used at consume time for an entitled caller MUST prefer the matrix for that caller's effective plan over environment defaults when a matrix row exists.

#### Scenario: Pro ceiling differs from Lite

- **WHEN** Lite and Pro have different daily ceilings for the same usage feature and an entitled Pro user consumes that feature
- **THEN** the Pro matrix ceiling is enforced, not the Lite matrix or a conflicting env default for that user

#### Scenario: Matrix uniqueness

- **WHEN** two usage-limit rows are inserted for the same plan and feature
- **THEN** the database rejects the duplicate

#### Scenario: Unknown usage feature rejected at seed or write

- **WHEN** application code attempts to persist or resolve a usage-limit matrix row for a feature outside the usage catalogue
- **THEN** the operation fails as a programming or validation error rather than creating an unbounded feature namespace

### Requirement: Entitlement and plan gates run after authorization

The system SHALL provide route annotations to require one or more entitlements and to require a minimum plan rank. Enforcement SHALL run as a global guard after authentication and authorization, and before request throttling and usage limits.

The guard MUST consume the already-resolved principal and MUST NOT re-resolve the session. Routes without entitlement or minimum-plan annotations MUST pass this stage without a plan check.

Denial MUST use a plan-specific error code distinct from RBAC `FORBIDDEN` and from usage or throttle codes. The response body MUST NOT enumerate the caller's full entitlement set.

#### Scenario: Missing entitlement denied

- **WHEN** an authenticated and RBAC-permitted user whose effective plan has the required entitlement disabled calls an entitlement-annotated route
- **THEN** the response is `403` with error code `ENTITLEMENT_DENIED` and the handler never executes

#### Scenario: Entitlement satisfied

- **WHEN** an authenticated user whose effective plan has the required entitlement enabled calls the route
- **THEN** the handler executes (subject to later guards)

#### Scenario: Minimum plan rank

- **WHEN** a route requires Pro and the caller's effective plan is Lite
- **THEN** the response is `403` with error code `ENTITLEMENT_DENIED`

#### Scenario: Unannotated route skips the gate

- **WHEN** a route carries no entitlement or minimum-plan annotation
- **THEN** the entitlements guard does not deny based on plan

#### Scenario: Gate runs before usage metering

- **WHEN** an entitled-denied request would also have exhausted a usage ceiling
- **THEN** the response is `ENTITLEMENT_DENIED` and usage counters for that request are not required to increment as a successful admission

#### Scenario: Principal not re-resolved

- **WHEN** the entitlements guard runs for an authenticated request
- **THEN** it reads the principal established by authentication and does not perform a separate session lookup

### Requirement: Default plans and matrices are seeded idempotently

Seeding MUST create or update the Lite, Pro, and Enterprise plans, their entitlement matrices, and their usage-limit matrices using upsert semantics and database uniqueness constraints so repeated runs neither duplicate nor fail.

#### Scenario: Seed twice

- **WHEN** the seed command runs twice against the same database
- **THEN** both runs exit `0` and no duplicate plan, entitlement, or usage-limit rows exist

#### Scenario: Re-seed after catalogue extension

- **WHEN** a new entitlement identifier is declared in code and the seed is re-run
- **THEN** each seeded plan gains a row for that entitlement without duplicating existing rows
