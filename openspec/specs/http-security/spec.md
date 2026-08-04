# HTTP Security

## Purpose

The transport-level hardening every response inherits: security headers suited to a JSON API, an explicit cross-origin allowlist, and session cookies whose attributes suit the environment that issued them.

One configuration value drives both the CORS allowlist and the authentication library's trusted origins, because a divergence between the two is either a request-forgery hole or an unexplainable rejection of a correctly configured client. Secrets and origins are validated before the server binds a port.

## Requirements

### Requirement: Security response headers appropriate to a JSON API

Every response SHALL carry security headers suited to an API that returns JSON and serves no browser-rendered content.

The header set MUST include a content security policy that permits no content sources and no framing, MIME-sniffing protection, and a referrer policy that emits no referrer. The framework's technology-advertising header MUST be removed. Strict transport security SHALL be emitted only when the service is served over HTTPS, so local plain-HTTP development is not pinned to HTTPS in the developer's browser.

#### Scenario: Headers present on an application response

- **WHEN** any application route responds
- **THEN** the response carries the content security policy, MIME-sniffing protection, and referrer policy headers

#### Scenario: Content sources denied

- **WHEN** the content security policy header is inspected
- **THEN** it permits no content sources by default and denies framing of the response

#### Scenario: Technology header removed

- **WHEN** any response is inspected
- **THEN** it carries no header advertising the server framework

#### Scenario: Transport security in production

- **WHEN** the service runs in a configuration that serves HTTPS
- **THEN** responses carry a strict transport security header

#### Scenario: No transport security in local development

- **WHEN** the service runs locally over plain HTTP
- **THEN** responses carry no strict transport security header

#### Scenario: Headers cover the authentication surface

- **WHEN** an authentication route responds
- **THEN** it carries the same security headers as application routes

#### Scenario: Headers cover error responses

- **WHEN** a request fails and an error response is returned
- **THEN** the security headers are still present

### Requirement: CORS uses an explicit origin allowlist and forbids wildcard with credentials

Cross-origin access SHALL be governed by an explicit allowlist of origins supplied through validated configuration, with credentialed requests permitted.

Because a wildcard origin and credentialed requests are mutually incompatible, configuration declaring both MUST fail validation at boot rather than produce responses browsers reject at integration time. An origin absent from the allowlist MUST NOT receive permissive cross-origin headers.

#### Scenario: Allowed origin

- **WHEN** a browser on an allowlisted origin makes a credentialed cross-origin request
- **THEN** the response permits that specific origin and allows credentials

#### Scenario: Disallowed origin

- **WHEN** a browser on an origin absent from the allowlist makes a cross-origin request
- **THEN** the response does not grant that origin cross-origin access

#### Scenario: Wildcard with credentials rejected at boot

- **WHEN** the application starts with a wildcard origin configured while credentialed CORS is in effect
- **THEN** validation fails and the application does not start

#### Scenario: Preflight

- **WHEN** a browser sends a preflight request from an allowlisted origin
- **THEN** the response permits the origin, the required methods, and credentials

### Requirement: One origin allowlist governs both CORS and the authentication origin check

The authentication library's trusted-origin list SHALL be derived from the same configuration value as the CORS allowlist.

There MUST NOT be a second place to configure origins, because a divergence between the two produces either a cross-site request forgery hole or an unexplainable rejection of a correctly configured client.

#### Scenario: Origins agree

- **WHEN** the configured allowlist is read
- **THEN** the CORS allowlist and the authentication library's trusted origins contain the same origins

#### Scenario: Untrusted origin on a state-changing auth request

- **WHEN** a state-changing authentication request arrives with an origin absent from the allowlist
- **THEN** it is rejected by the origin check

#### Scenario: Adding an origin

- **WHEN** an origin is added to the configuration value
- **THEN** both CORS and the authentication origin check accept it, with no second edit required

### Requirement: Session cookie attributes are hardened and environment-appropriate

Session cookies SHALL be marked `HttpOnly`, signed, scoped to the root path, and sent with `SameSite=Lax`.

The `Secure` attribute MUST be set in every environment except local plain-HTTP development, and selecting the relaxed variant MUST be a deliberate configuration act rather than an accident of environment detection. `SameSite=Lax` is required rather than `Strict` because `Strict` breaks the return leg of an external sign-in redirect.

#### Scenario: Attributes on an issued cookie

- **WHEN** a session cookie is issued in a deployed environment
- **THEN** it carries `HttpOnly`, `Secure`, `SameSite=Lax`, and a root path

#### Scenario: Local development over plain HTTP

- **WHEN** the application runs locally over plain HTTP
- **THEN** the cookie is issued without `Secure` so local sign-in works, and every other attribute is unchanged

#### Scenario: External sign-in redirect returns

- **WHEN** a user completes a social sign-in and the provider redirects back to the application
- **THEN** the session cookie is sent on the return request and the session is established

#### Scenario: Cookie unreadable by page scripts

- **WHEN** a session cookie is inspected in a browser context
- **THEN** it is not readable from script because it is marked `HttpOnly`

### Requirement: Secrets and origins are validated before the server binds a port

Authentication secrets and origin configuration SHALL be validated at boot, consistent with the application's fail-fast configuration contract.

The signing secret MUST be required with a documented minimum length and MUST have no default in any environment.

#### Scenario: Signing secret missing

- **WHEN** the application starts without the authentication signing secret
- **THEN** validation fails, the error names the variable, and no port is bound

#### Scenario: Signing secret too short

- **WHEN** the signing secret is shorter than the documented minimum
- **THEN** validation fails and names the constraint

#### Scenario: Malformed origin

- **WHEN** the origin allowlist contains a value that is not a valid origin
- **THEN** validation fails and names the offending value
