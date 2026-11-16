# Registered-user Clarity access

Status: target access contract established from Marcus's instruction, November 16, 2026. This document does not establish that registration, token-enabled prompt/utility endpoints or local client migration are deployed. The existing SSH/operator-HMAC implementation is a development baseline, not the user onboarding pattern.

## User and agent flow

1. The owner begins the bootstrap in their chosen local harness and registers or signs in through Clarity's existing website authentication. Use the established account bootstrap to associate the authenticated user with their organization.
2. Registration connects this installation/harness to a server-assigned unique agent UUID and handle belonging to that organization. Reuse the same installation identity on retries; never clone another agent's identity or treat a local candidate UUID as network registration.
3. Clarity issues a `clrtok_` token using its existing hashed-token machinery. One token for this registered installation serves its A2A communication and MCP remote operations. Registration returns non-secret connection metadata with the token: API origin, organization ID, agent ID/handle, available capabilities and prompt identifiers.
4. Store the token through the owner's operating-system credential store or existing secret-command facility. The local connection profile contains only its secret reference and non-secret identity/endpoint metadata. Never put the token in business CONTEXT, journals, assessments, Git, URLs, command arguments or logs. Environment injection is supported where the existing service manager provides it safely.
5. The local `clarity_m3ntor` service and A2A adapter read that same credential source and send `Authorization: Bearer <clarity-token>` to the configured Clarity HTTPS API. They need no SSH account, tunnel, private server path, operator HMAC secret or Supabase service key.
6. Verify the authenticated organization/agent identity, retrieve the designated starter-flow utility case, fetch the current mentor/reassessment prompts and establish A2A receipt/reply evidence. Distinguish each result: token issuance, authenticated access, agent registration, live inbound connection, message acceptance/delivery and completed agent work are separate claims.

The Clarity token authorizes Clarity operations. It does not grant access to the owner's email, documents, calendar, financial records or other business systems; those continue through the owner's established local connections and authority.

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

Reuse Clarity's existing website/Supabase user authentication, account graph and `clrtok_` token generation, hashing, validation, expiry and revocation. A signup currently creates a customer-role profile; the generic token-management endpoint currently requires an admin JWT. The product registration flow therefore needs to issue its own product token for the authenticated owner's account rather than requiring global-admin promotion or handing an operator secret to the customer.

Bind the issued token to its organization and registered agent through server-owned records. Resolve sender/report attribution from that binding; an arbitrary supplied organization ID, handle or agent ID does not authenticate ownership. Preserve supported cross-organization A2A communication through registered recipients; it does not authorize reading another organization's inbox, private reports or identities outside the network's discoverable profile.

Capabilities needed by this product are registration/identity lookup, sending and receiving A2A messages, current prompt reading, own-business assessment/profile reporting and retrieval, and shared utility reporting/search/read. Their scope names must be added to the existing scope registry during implementation; they are not currently available token scopes. No general customer-record, financial-record, token-administration or server-administration entitlement is implied by installing M3NT0R.

The owner can revoke or rotate the installation token through authenticated Clarity account controls. A rotated token retains the registered agent's identity and conversation continuity. Return invalid/expired/revoked states honestly, preserving queued local work without retrying rejected credentials endlessly or substituting a different identity.

Registration retries reconcile the existing agent by an installation identifier within the authenticated owner's organization; that identifier is not a credential. Token plaintext is returned only when issued, not retrieved from its stored hash. If the issuance response is lost, authenticated account recovery rotates the token for that same agent rather than registering a duplicate agent.

## HTTPS operation contract

The following registration/prompt/report paths are proposed product contracts to implement. Existing utility/A2A paths are reused, but their token authorization and identity isolation still require verification. Advertise the canonical API origin and capabilities in the registration response; clients do not guess a server filesystem path.

| Operation | Authentication | Contract/status |
| --- | --- | --- |
| Account association | Existing user JWT | Reuse `POST /account/bootstrap`; does not itself issue a product token |
| Register this agent and receive token | Existing user JWT | Proposed `POST /agent/mentor/registrations`, idempotent for the authenticated installation; returns identity, token once and connection metadata |
| Verify token and assigned identity | Clarity token | Proposed `GET /agent/mentor/me` |
| Read coach instructions | Clarity token | Proposed `GET /agent/mentor/prompts/coach` |
| Read periodic reassessment instructions | Clarity token | Proposed `GET /agent/mentor/prompts/poma-reassessment` |
| Report/read own non-sensitive profile and POMA summary | Clarity token | Proposed `POST /agent/mentor/assessments` and `GET /agent/mentor/assessments`; preserve revision/submission identity |
| Report utility | Clarity token | Existing `POST /agent/utility/cases`; currently operator-HMAC-only, needs token support |
| Find/read utility | Clarity token | Existing `POST /agent/utility/search` and `GET /agent/utility/cases/{id}`; currently operator-HMAC-only, needs token support |
| Send/reply/receive A2A | Clarity token | Reuse `/agent/agent_messages`, `/reply`, `/stream` and status routes; verify required capabilities and registered-sender/inbox ownership |

Prompt responses identify the prompt, version, content hash and current text. The server maps supported prompt identifiers to its stored content; users never provide a filesystem path. The local worker records provenance and runs the received prompt in the owner's existing harness. Fetch every new job's current prompt; a token/connection failure is not permission to run an old bundled prompt or claim successful access.

Private local assessment/context/journal data and detailed productivity inputs remain local. Central assessment/profile reports contain only the separately prepared non-sensitive summary and appropriate ratings. Shared utility cases contain only the authorized non-sensitive process synthesis. Utility searching may read the shared library across participating businesses; private business reports remain organization-bound. Existing curated utility cases must remain retrievable without pretending they belong to a newly registered user. Reporting, record ownership and sharing provenance must be represented explicitly on the server.

## Components to change before user rollout

- Registration: connect existing signup/account association to product agent registration and token issuance, without assuming the customer role can use the admin token endpoint.
- Authorization/storage: add product capabilities, registered-agent token binding, organization ownership for private reports/submissions and own-inbox checks. Preserve unrelated existing operator routes.
- Prompt delivery: add token-authenticated HTTPS prompt endpoints returning current server content and provenance.
- Utility API: accept the same registered-user token for reporting/search/read and attribute submissions from authenticated identity; retain idempotence, shared-case provenance and actual hybrid search.
- Local MCP: replace its SSH prompt fetch and `a2a-bridge` HMAC configuration dependency with the shared profile/token HTTPS client. Keep the detached local harness, private persistence and job/result semantics.
- A2A: use the same credential source and registered identity in the appropriate current-harness adapter; retain conversations and actual completion distinctions.
- User setup: provide registration/credential handoff and capability verification. Do not publish a registration-page URL or automatic token command as live until deployed and read back.

## Verification for delivery

A newly registered non-operator user must receive their own token/agent identity, authenticate over HTTPS, fetch both prompts, read case `0a4666fa-e567-4c14-93c2-11ae67a7682d`, report/retrieve an idempotent non-sensitive utility case, and complete an A2A round trip without SSH or operator secrets. Verify private assessment reporting/readback and that a second organization's token cannot impersonate the first agent or read its private inbox/reports. Verify revoked/invalid tokens fail explicitly, local queued work remains intact and secrets are absent from logs/Git/requests other than the intended HTTPS authorization header. Reuse prior valid local-runner and utility-search evidence, but do not treat earlier operator-HMAC/SSH passes as proof of this registered-user access contract.
