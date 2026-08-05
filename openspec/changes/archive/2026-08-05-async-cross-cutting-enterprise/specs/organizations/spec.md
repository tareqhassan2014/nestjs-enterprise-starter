## ADDED Requirements

### Requirement: Organization entity and membership

The system SHALL persist organizations with a unique slug and display name, and SHALL persist membership rows binding users to organizations with a role of at least `owner`, `admin`, or `member`.

A user MUST NOT appear twice in the same organization. Deleting an organization MUST remove or cascade its membership rows according to the schema rules.

#### Scenario: Create organization makes creator owner

- **WHEN** an authenticated user creates an organization with a new slug
- **THEN** the organization exists and the creator is recorded as a member with role `owner`

#### Scenario: Duplicate slug rejected

- **WHEN** a second organization is created with an existing slug
- **THEN** the operation fails with conflict semantics and no duplicate org row exists

#### Scenario: Membership uniqueness

- **WHEN** the same user is added twice to the same organization
- **THEN** the database or domain layer rejects the duplicate membership

### Requirement: Request organization binding requires membership

When a request binds an organization context (header or documented equivalent), the system SHALL accept the binding only if the authenticated user is a member of that organization. Forged or unknown organization ids MUST NOT grant org context.

#### Scenario: Member binds own org

- **WHEN** a member sends a valid organization binding for an org they belong to
- **THEN** request context exposes that organization id for downstream resolvers

#### Scenario: Non-member binding rejected

- **WHEN** an authenticated user binds an organization id they do not belong to
- **THEN** the request is rejected with `403` / `FORBIDDEN` (or a documented org-context error) and no org billing subject is established

### Requirement: Billing subject hooks for org-primary mode

The system SHALL expose a billing-subject resolver that returns either a user subject or an organization subject. When an organization is bound and that organization's billing mode is org-primary, the resolver MUST return the organization subject; otherwise it MUST return the authenticated user subject.

Credits and subscription/plan resolution MUST consume this resolver rather than hard-coding user id when org-primary hooks are active.

#### Scenario: Org-primary context yields organization subject

- **WHEN** a member binds an org configured for org-primary billing
- **THEN** the billing subject type is `organization` with that organization id

#### Scenario: User-primary default

- **WHEN** no organization is bound, or the org billing mode is user-primary
- **THEN** the billing subject type is `user` with the authenticated user id

### Requirement: Minimal authenticated org read surface

The system SHALL expose authenticated, enveloped endpoints sufficient to create an organization, list organizations for the caller, and manage membership for callers with adequate org role. The surface MUST NOT require building a full invitations or SSO product.

#### Scenario: Caller lists own organizations

- **WHEN** an authenticated user lists organizations
- **THEN** the response includes only organizations where they are a member
