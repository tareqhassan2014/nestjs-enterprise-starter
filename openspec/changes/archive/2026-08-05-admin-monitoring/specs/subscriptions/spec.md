## ADDED Requirements

### Requirement: Cross-user subscription inspection is an admin concern

Inspection of another user's subscription and effective plan SHALL be provided only through the admin monitoring HTTP surface and MUST require `admin:subscriptions:read`.

The authenticated current-plan read surface MUST remain limited to the caller's own effective plan and MUST NOT require staff permissions beyond authentication.

#### Scenario: Self-service current plan stays own-user

- **WHEN** an authenticated non-admin user requests the current-plan endpoint
- **THEN** the response describes that user's effective plan and does not expose another user's subscription

#### Scenario: Admin inspection uses the same resolution rules

- **WHEN** an admin reads another user's subscription view
- **THEN** the effective plan matches what plan gates and usage matrices would resolve for that user id
