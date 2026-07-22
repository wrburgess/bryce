# Hosted AI-agent connector authentication: static-header beta now, OAuth front door next

Bryce's `/mcp` endpoint authenticates with a static bearer token behind Cloudflare Access
([ADR 0027](0027-mcp-first-interface-no-web-ui.md), [ADR 0028](0028-local-macbook-hosting-cloudflare-tunnel.md)),
but the hosted AI-agent connectors the HC wants to use don't accept that uniformly. As of July 2026:
Claude's hosted surfaces (claude.ai web, iPhone, Desktop, Cowork) support a **`static_headers` beta**
— an org admin enters the bearer once when adding the connector — *and* full OAuth (`oauth_dcr` /
`oauth_cimd`, GA); ChatGPT (Developer Mode custom connectors) requires **OAuth** (CIMD recommended,
DCR supported), with no first-class static-header path; and the **consumer Gemini app cannot add a
self-hosted server at all** (its connectors are partnership-only). Connecting these is therefore an
auth-capability problem, not a documentation one — which is why documenting the connection
([#66](https://github.com/wrburgess/bryce/issues/66)) *depends on* making it work
([#37](https://github.com/wrburgess/bryce/issues/37)).

We take this in two phases. **Phase 1** brings the Claude surfaces up with zero new code by using the
`static_headers` beta with Bryce's existing token (tracked in #37; this is the beta the issue was
filed to verify). **Phase 2** stands up a spec-compliant OAuth front door so ChatGPT connects and
Claude no longer depends on a beta: a small **Cloudflare Worker running `workers-oauth-provider`**
sits in front of the Tunnel as the authorization server + proxy, injecting the existing bearer to
Bryce so the Node app's internals stay unchanged. It is chosen over **Cloudflare Access as the
authorization server** (could not confirm Access advertises the DCR/CIMD registration both Claude and
ChatGPT expect) and over an **external IdP** (Auth0/Stytch/WorkOS — another SaaS dependency for a
single-user app). Bryce gains only the resource-server half of the handshake: a `401` with
`WWW-Authenticate: Bearer resource_metadata=…`, a `/.well-known/oauth-protected-resource` document
naming the authorization server, and validation of its access tokens. Because a headless connector
cannot complete Cloudflare Access's interactive browser login, `/mcp` is **exempted from the Access
browser policy** (or Access itself becomes the connector's authorization server) rather than stacking
both auth layers — the "two auth layers" tension #37 flagged. Anthropic's egress range
`160.79.104.0/21` must reach the authorization server (a WAF in front of it breaks discovery).

The explicit no: the **consumer Gemini app is unsupported** — partnership-only connectors leave no
self-hosted path, so Gemini reaches Bryce only through **Gemini CLI**, which takes a static header
like Claude Code. Revisit only if Google opens consumer-app connectors to arbitrary remote MCP
servers.
