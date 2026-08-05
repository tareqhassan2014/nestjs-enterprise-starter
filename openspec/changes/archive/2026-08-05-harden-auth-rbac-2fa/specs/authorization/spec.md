## MODIFIED Requirements

### Requirement: Effective permissions are cached with versioned invalidation

Effective permission sets SHALL be resolved at most once per request and MAY be cached across requests. Cache invalidation SHALL be performed by advancing a version marker rather than by enumerating or deleting cache keys.

A mutation to any role, mapping, or assignment MUST cause subsequent requests to observe the new state. A cache read failure MUST fall back to the persisted store rather than deny the request.

The invalidation path MUST be reachable from every process that mutates access-control data, including one that is not the running application — the seed and any operator tooling mutate the same tables and MUST be able to advance the marker without a running instance. An invalidation mechanism callable only from inside the application process, or only from a test, does not satisfy this requirement: it makes the guarantee an artefact of the test harness rather than a property of the system.

Where a mutation is applied without advancing the marker, the resulting staleness SHALL be bounded by the cache entry lifetime, and that bound SHALL be documented as the worst case rather than left implied. A caller MUST NOT have to infer it from a constant in the source.

#### Scenario: Repeated checks within one request

- **WHEN** a single request evaluates two permission requirements
- **THEN** the effective permission set is resolved once for that request

#### Scenario: Mapping change is observed

- **WHEN** a role's permission mapping changes and a user holding that role makes a request
- **THEN** the request is evaluated against the new mapping

#### Scenario: Revocation is observed

- **WHEN** a role is removed from a user
- **THEN** their next request no longer carries that role's permissions

#### Scenario: Seed advances the marker

- **WHEN** the seed runs against a migrated database while an application instance is serving traffic
- **THEN** the marker is advanced, and a user whose grants the seed changed is evaluated against the new mapping on their next request

#### Scenario: Invalidation is reachable outside the application process

- **WHEN** the invalidation path is inspected
- **THEN** it can be invoked by a process that is not the running application, without depending on the application's dependency injection container

#### Scenario: Staleness bound is stated

- **WHEN** a mutation is applied without advancing the marker
- **THEN** the delay before it is observed is no longer than the documented cache entry lifetime

#### Scenario: Cache unavailable

- **WHEN** the permission cache is unreachable and an authenticated user calls a permission-gated route
- **THEN** the decision is made from the persisted store and the request is not denied because of the cache

#### Scenario: Stale entries are unreachable

- **WHEN** the version marker advances
- **THEN** entries written under the previous version are never read again
