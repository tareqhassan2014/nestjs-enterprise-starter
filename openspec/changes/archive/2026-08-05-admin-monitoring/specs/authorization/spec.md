## ADDED Requirements

### Requirement: Admin monitoring permissions in the vocabulary

The permission vocabulary SHALL include operational admin identifiers for metrics reads, audit reads, cross-user subscription reads, cross-user credit reads, and credit adjustments.

At minimum the set MUST include `admin:metrics:read`, `admin:audit:read`, `admin:subscriptions:read`, `admin:credits:read`, and `admin:credits:adjust`. The baseline `admin` role MUST receive every declared permission, including these. The baseline `user` role MUST NOT receive them.

#### Scenario: Catalogue includes admin monitoring permissions

- **WHEN** the code-declared permission catalogue is inspected
- **THEN** it contains `admin:metrics:read`, `admin:audit:read`, `admin:subscriptions:read`, `admin:credits:read`, and `admin:credits:adjust`

#### Scenario: Seed grants admin all permissions

- **WHEN** the seed runs against a migrated database
- **THEN** the `admin` role mapping includes every declared permission identifier

#### Scenario: User role lacks admin monitoring permissions

- **WHEN** the seeded `user` role permissions are inspected
- **THEN** they do not include `admin:metrics:read`, `admin:audit:read`, `admin:subscriptions:read`, `admin:credits:read`, or `admin:credits:adjust`
