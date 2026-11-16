# Registered-user Clarity access

Status: target access contract established from Marcus's instruction, November 16, 2026. This document does not establish that registration, token-enabled prompt/utility endpoints or local client migration are deployed. The existing SSH/operator-HMAC implementation is a development baseline, not the user onboarding pattern.

## User and agent flow

1. The owner begins the bootstrap in their chosen local harness. The agent registers and signs in through HTTPS API calls; there is no website, browser, device-code page or other UI step. Reuse the owner's authorized account credentials or existing Clarity token. For a new account, use the owner's established contact identity and generate/store its credential locally; never fabricate an email address or reset an existing account to bypass missing credentials. Use the account bootstrap API to associate the authenticated account with its organization.
2. Registration connects this installation/harness to a server-assigned unique agent UUID and handle belonging to that organization. Reuse the same installation identity on retries; never clone another agent's identity or treat a local candidate UUID as network registration.
3. Clarity issues a `clrtok_` token using its existing hashed-token machinery. One token for this registered installation serves its A2A communication and MCP remote operations. Registration returns non-secret connection metadata with the token: API origin, organization ID, agent ID/handle, available capabilities and prompt identifiers.
4. Store the token through the owner's operating-system credential store or existing secret-command facility. The local connection profile contains only its secret reference and non-secret identity/endpoint metadata. Never put the token in business CONTEXT, journals, assessments, Git, URLs, command arguments or logs. Environment injection is supported where the existing service manager provides it safely.
5. The local `clarity_m3ntor` service and A2A adapter read that same credential source and send `Authorization: Bearer <clarity-token>` to the configured Clarity HTTPS API. They need no SSH account, tunnel, private server path, operator HMAC secret or Supabase service key.
6. Verify the authenticated organization/agent identity, retrieve the designated starter-flow utility case, fetch the current mentor and unified business-assessment prompts and establish A2A receipt/reply evidence. `assess_poma` uses one assessment prompt for baseline and later/weekly runs; `reassess_poma` is its compatibility alias. Distinguish each result: token issuance, authenticated access, agent registration, live inbound connection, message acceptance/delivery and completed agent work are separate claims.

The Clarity token authorizes Clarity operations. It does not grant access to the owner's email, documents, calendar, financial records or other business systems; those continue through the owner's established local connections and authority.

## Headless registration and sign-in

The agent's HTTP client performs this sequence:

1. On later starts, load the stored Clarity token and call `GET /agent/mentor/me`. A valid token signs this agent in for product operations; do not create another account or registration on every session.
2. On first setup, reuse an authorized existing account session or call `POST /auth/login` with its stored credentials. For a new account call `POST /auth/signup` with `email`, `password` and available `company_name`/`username`. These existing routes return session state and set authentication cookies; they do not currently return the access token in the JSON response. A non-browser HTTP client can handle those cookies and supply the session JWT from `clarity_access_token` as the bearer credential for subsequent account operations. Keep session secrets out of model-visible tool output and logs.
3. With that authenticated account session, call `POST /account/bootstrap`, then the proposed `POST /agent/mentor/registrations`. Receive the assigned agent identity, Clarity token and connection metadata directly in the API response and store them locally. Use the Clarity token for subsequent A2A and MCP remote operations; the account session is for enrollment and account recovery, not the ongoing product credential.
4. Reuse stored account credentials/session for token rotation or recovery without changing the registered agent identity. An expired/revoked token is not permission to create a replacement identity silently.

If the authentication provider requires email verification, signup can currently return `authenticated: false` without a usable session. Product onboarding must expose a machine-readable pending state and API verification/recovery path that the agent can complete through the owner's authorized email access. Do not assume that path exists, silently disable verification, treat signup acceptance as sign-in or fall back to a browser. Missing account credentials, contact identity or email access must be reported specifically; an email address alone does not establish ownership of an existing account.

## One local connection profile

Target location: `~/.config/clarity_m3ntor/config.json`. This is the shared client contract to implement, not a config already read by the current source.

```json
{
  "api_url": "https://api.claritycustomsoftware.com",
  "organization_id": "<server-returned organization UUID>",
  "agent_id": "<server-assigned agent UUID>",
  "agent_handle": "<server-assigned handle>",
  "token_env": "CLARITY_TOKEN"
}
```

`token_env` names an injected variable; it is not the secret value. An alternative `token_command` is an argument array for the owner's existing secret store and executes without a shell. Select one configured credential source; both clients use it. Preserve any existing user's account and billing route. Do not fall back to operator HMAC or SSH if a user token is missing, rejected, expired or revoked.

The local MCP remains on loopback and is connected to the current harness. Its outbound Clarity client uses HTTPS and the token. The registered agent's A2A receiver uses the same API origin/identity/token and a supported HTTPS stream or polling transport. The existing public `a2a-connect` is a Codex-specific transport reference; it is not evidence that a Claude adapter or the shared-profile integration already works.

## Authentication and identity

Reuse Clarity's existing Supabase-backed HTTP authentication APIs, account graph and `clrtok_` token generation, hashing, validation, expiry and revocation. A signup currently creates a customer-role profile; the generic token-management endpoint currently requires an admin JWT. The product registration flow therefore needs to issue its own product token for the authenticated owner's account rather than requiring global-admin promotion or handing an operator secret to the customer.

Bind the issued token to its organization and registered agent through server-owned records. Resolve sender/report attribution from that binding; an arbitrary supplied organization ID, handle or agent ID does not authenticate ownership. Preserve supported cross-organization A2A communication through registered recipients; it does not authorize reading another organization's inbox, private reports or identities outside the network's discoverable profile.

Capabilities needed by this product are registration/identity lookup, sending and receiving A2A messages, current prompt reading, own-business assessment/profile reporting and retrieval, and shared utility reporting/search/read. Their scope names must be added to the existing scope registry during implementation; they are not currently available token scopes. No general customer-record, financial-record, token-administration or server-administration entitlement is implied by installing M3NT0R.

The agent can revoke or rotate the installation token through authenticated Clarity account APIs on the owner's behalf. A rotated token retains the registered agent's identity and conversation continuity. Return invalid/expired/revoked states honestly, preserving queued local work without retrying rejected credentials endlessly or substituting a different identity.

Registration retries reconcile the existing agent by an installation identifier within the authenticated owner's organization; that identifier is not a credential. Token plaintext is returned only when issued, not retrieved from its stored hash. If the issuance response is lost, authenticated account recovery rotates the token for that same agent rather than registering a duplicate agent.

## HTTPS operation contract

The following registration/prompt/report paths are proposed product contracts to implement. Existing utility/A2A paths are reused, but their token authorization and identity isolation still require verification. Advertise the canonical API origin and capabilities in the registration response; clients do not guess a server filesystem path.

| Operation | Authentication | Contract/status |
| --- | --- | --- |
| Sign up / sign in | Account credentials over HTTPS | Existing `POST /auth/signup` and `POST /auth/login`; handle session cookies without a browser; verification completion still needs a headless product path where required |
| Account association | Existing user JWT | Reuse `POST /account/bootstrap`; does not itself issue a product token |
| Register this agent and receive token | Existing user JWT | Proposed `POST /agent/mentor/registrations`, idempotent for the authenticated installation; returns identity, token once and connection metadata |
| Verify token and assigned identity | Clarity token | Proposed `GET /agent/mentor/me` |
| Read coach instructions | Clarity token | Proposed `GET /agent/mentor/prompts/coach` |
| Read baseline and later/weekly business assessment instructions | Clarity token | Proposed `GET /agent/mentor/prompts/poma-assessment`; one unified assessment prompt |
| Report/read own non-sensitive profile and POMA summary | Clarity token | Proposed `POST /agent/mentor/assessments` and `GET /agent/mentor/assessments`; preserve revision/submission identity |
| Report utility | Clarity token | Existing `POST /agent/utility/cases`; currently operator-HMAC-only, needs token support |
| Find/read utility | Clarity token | Existing `POST /agent/utility/search` and `GET /agent/utility/cases/{id}`; currently operator-HMAC-only, needs token support |
| Send/reply/receive A2A | Clarity token | Reuse `/agent/agent_messages`, `/reply`, `/stream` and status routes; verify required capabilities and registered-sender/inbox ownership |

Prompt responses identify the prompt, version, content hash and current text. The server maps supported prompt identifiers to its stored content; users never provide a filesystem path. The local worker records provenance and runs the received prompt in the owner's existing harness. Fetch every new job's current prompt; a token/connection failure is not permission to run an old bundled prompt or claim successful access. Assessment and mentor publishing sources are private local operator files excluded from the current source tree; fresh clones contain neither. The obsolete separate reassessment source is deleted. The current operator development runtime still fetches over SSH; these HTTPS endpoints and token migration remain proposed, not implemented by prompt consolidation.

Private local assessment/context/journal data and detailed productivity inputs remain local. Central assessment/profile reports contain only the separately prepared non-sensitive summary and appropriate ratings. Shared utility cases contain only the authorized non-sensitive process synthesis. Utility searching may read the shared library across participating businesses; private business reports remain organization-bound. Existing curated utility cases must remain retrievable without pretending they belong to a newly registered user. Reporting, record ownership and sharing provenance must be represented explicitly on the server.

## Components to change before user rollout

- Registration: provide an agent-callable HTTP client for signup/login, session handling, any required verification/recovery, account association and product agent registration/token issuance. No browser/UI dependency; do not assume the customer role can use the admin token endpoint.
- Authorization/storage: add product capabilities, registered-agent token binding, organization ownership for private reports/submissions and own-inbox checks. Preserve unrelated existing operator routes.
- Prompt delivery: add token-authenticated HTTPS prompt endpoints returning current server content and provenance.
- Utility API: accept the same registered-user token for reporting/search/read and attribute submissions from authenticated identity; retain idempotence, shared-case provenance and actual hybrid search.
- Local MCP: replace its SSH prompt fetch and `a2a-bridge` HMAC configuration dependency with the shared profile/token HTTPS client. Keep the detached local harness, private persistence and job/result semantics.
- A2A: use the same credential source and registered identity in the appropriate current-harness adapter; retain conversations and actual completion distinctions.
- Agent setup: return registration/credential handoff and capability metadata directly through the API. Do not advertise a working enrollment command until deployed and verified.

## Verification for delivery

An agent acting for a new non-operator user must complete API-only signup/sign-in and registration, with no UI/browser activity, then receive their own token/agent identity, authenticate over HTTPS, fetch the mentor and unified business-assessment prompts, read case `0a4666fa-e567-4c14-93c2-11ae67a7682d`, report/retrieve an idempotent non-sensitive utility case, and complete an A2A round trip without SSH or operator secrets. Verify restart sign-in with the stored token reuses the same account/agent, and required verification/recovery can complete without UI. Verify private assessment reporting/readback and that a second organization's token cannot impersonate the first agent or read its private inbox/reports. Verify revoked/invalid tokens fail explicitly, local queued work remains intact and secrets are absent from logs/Git/requests other than the intended HTTPS authorization header. Reuse prior valid local-runner and utility-search evidence, but do not treat earlier operator-HMAC/SSH passes as proof of this registered-user access contract.
