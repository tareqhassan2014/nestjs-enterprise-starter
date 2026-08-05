# File Storage

## Purpose

A provider-agnostic object storage port: application code puts, gets, and deletes binary objects by opaque key through a single injectable port, and an adapter (local filesystem or S3-compatible) does the actual I/O. Replacing the provider means changing one configuration value, not calling code.

The local filesystem adapter is convenient for development and tests but cannot be selected in production, where an S3-compatible adapter with a complete credential group is required.

## Requirements

### Requirement: Provider-agnostic object storage port

Application code SHALL read and write binary objects only through a single injectable storage port that supports put, get, and delete by opaque object key. Calling code MUST NOT import the S3 client or write directly to ad-hoc filesystem paths outside the local adapter.

#### Scenario: Feature stores an object via the port

- **WHEN** a module stores a file under a key through the storage port
- **THEN** the object is retrievable by the same key through the port regardless of the configured driver

#### Scenario: Provider replacement

- **WHEN** configuration switches from the local driver to the S3 driver with a complete credential/bucket group
- **THEN** no calling feature module requires source changes beyond configuration

### Requirement: Local and S3 adapters selected by configuration

The system SHALL supply a local filesystem adapter and an S3-compatible adapter. The driver SHALL be chosen by a validated configuration value. When S3 is selected, bucket, region, and credential settings MUST be required as a group; a partial group MUST fail validation at boot.

#### Scenario: Local driver in development

- **WHEN** the local driver is configured with a storage root directory and an object is put
- **THEN** the object is stored under that root and no S3 network call is made

#### Scenario: S3 half-configured

- **WHEN** the S3 driver is selected with a bucket present but credentials missing where required
- **THEN** validation fails at boot naming the missing variables

### Requirement: Local driver cannot be selected in production

Selecting the local storage driver while running in the production environment SHALL fail validation at boot.

#### Scenario: Local driver in production

- **WHEN** the application starts in production with `STORAGE_DRIVER=local`
- **THEN** validation fails and no storage port is bound for serving traffic

### Requirement: Object keys and credentials are not logged in full

Log output SHALL NOT contain storage secret keys or full object bodies. Object keys MAY be logged when needed for operations, but credentials MUST never appear in logs.

#### Scenario: Put is logged

- **WHEN** a put operation is logged
- **THEN** the entry may include the object key and MUST NOT include the secret access key or object bytes
