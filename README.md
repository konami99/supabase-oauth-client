# Supabase OAuth Client via AWS Bedrock AgentCore

A Node.js/Express web app that performs a Supabase OAuth 2.0 authorization code flow using AWS Bedrock AgentCore as the identity broker. AgentCore handles PKCE generation, the token exchange, and stores the resulting access token in its token vault.

---

## Architecture

```
Browser → Express App → AWS Bedrock AgentCore → Supabase OAuth
```

There are two separate authentication layers:

1. **App authentication** — the user logs into the Express app with email/password (Supabase password grant). This sets a `supabase_jwt` cookie that identifies the user (by their Supabase `sub` claim) to our server. This is needed so the server knows which AgentCore user identity to associate the token with.

2. **OAuth authorization** — AgentCore acts as the OAuth client on behalf of the user. It generates PKCE, redirects the user through Supabase's consent UI, exchanges the authorization code, and stores the resulting access token in its vault keyed by `(workload, userId, credentialProvider, scopes)`.

---

## Prerequisites

### 1. Supabase OAuth App

Create an OAuth app in **Supabase Dashboard → Authentication → OAuth Apps**:

- Note the `CLIENT_ID` and `CLIENT_SECRET`
- Add the AgentCore callback URL as an allowed redirect URI:
  ```
  https://bedrock-agentcore.us-west-2.amazonaws.com/identities/oauth2/callback/<provider-uuid>
  ```
- **Disable PKCE enforcement** — AgentCore handles PKCE internally. Do not request the `openid` scope (Supabase HS256 projects cannot generate ID tokens).

### 2. AgentCore Credential Provider

Create a `CustomOauth2` credential provider via the AWS CLI:

```bash
aws bedrock-agentcore-control create-oauth2-credential-provider \
  --name "my-supabase-provider" \
  --credential-provider-vendor "CustomOauth2" \
  --oauth2-provider-config-input '{
    "customOauth2ProviderConfig": {
      "oauthDiscovery": {
        "discoveryUrl": "https://<project-ref>.supabase.co/auth/v1/.well-known/openid-configuration"
      },
      "clientId": "<CLIENT_ID>",
      "clientSecret": "<CLIENT_SECRET>"
    }
  }' \
  --region us-west-2
```

Note the returned `callbackUrl` — register it in your Supabase OAuth app's allowed redirect URIs.

### 3. AgentCore Workload Identity

Create a workload identity that is **not linked to a service**:

```bash
aws bedrock-agentcore-control create-workload-identity \
  --name "my-webapp" \
  --allowed-resource-oauth2-return-urls '["https://your-app-url.com/callback"]' \
  --region us-west-2
```

> `allowed-resource-oauth2-return-urls` is the URL AgentCore redirects the browser to after storing the authorization code. It must match `SITE_URL/callback`.

> **Note:** Do not use a workload identity linked to an AgentCore agent runtime — those cannot issue tokens to external callers.

---

## Environment Variables

```env
# Supabase
PROJECT_REF=your-supabase-project-ref
CLIENT_ID=your-supabase-oauth-client-id
CLIENT_SECRET=your-supabase-oauth-client-secret
REDIRECT_URI=https://bedrock-agentcore.us-west-2.amazonaws.com/identities/oauth2/callback/<provider-uuid>

# AgentCore
WORKLOAD_NAME=my-webapp
CREDENTIAL_PROVIDER_NAME=my-supabase-provider

# App
PORT=3000
SITE_URL=https://your-app-url.com
AWS_REGION=us-west-2
SUPABASE_ANON_KEY=your-supabase-anon-key
```

---

## OAuth Flow

### Step 1 — App login (`POST /login`)

The user enters their Supabase email and password. The server calls the Supabase password grant endpoint and stores the returned JWT in an `HttpOnly` cookie. The JWT's `sub` claim is used as the `userId` for all AgentCore calls.

This step is separate from the OAuth flow — it only establishes who the user is within this app.

---

### Step 2 — Initiate OAuth (`GET /auth-url`)

When the user clicks "supabase auth", the browser calls `/auth-url`. The server:

1. Calls `GetWorkloadAccessTokenForUserIdCommand(workloadName, userId)`
   - Returns a short-lived `workloadAccessToken` proving this workload+user identity
2. Calls `GetResourceOauth2TokenCommand` with the workload token

**Two possible responses:**

- **Token already cached** — AgentCore finds a stored token for this `(workload, userId, credentialProvider, scopes)` combination and returns `accessToken` directly. No OAuth redirect is needed.
- **No cached token** — AgentCore creates a session, generates PKCE internally, and returns `authorizationUrl` (an AgentCore PAR endpoint URL). The browser is redirected there.

---

### Step 3 — AgentCore → Supabase (internal)

This step happens entirely inside AgentCore's infrastructure — there is no code in this app for it.

When the browser navigates to the `authorizationUrl` from Step 2, AgentCore's servers handle the request: they look up the stored session, construct the Supabase authorize URL with the PKCE params they generated, and redirect the browser there:

```
https://<project-ref>.supabase.co/auth/v1/oauth/authorize
  ?response_type=code
  &client_id=<CLIENT_ID>
  &redirect_uri=<AgentCore callbackUrl>
  &code_challenge=<generated by AgentCore>
  &code_challenge_method=S256
  &state=<session state>
```

---

### Step 4 — User authenticates on Supabase (conditional)

This step only appears if the user does not already have an active Supabase browser session. If the user is already logged into Supabase in the browser, or if the OAuth app has consent auto-approved, Supabase skips the login/consent page and redirects immediately to the AgentCore callback URL.

If shown, Supabase displays its hosted login and consent page. After the user logs in and grants consent, Supabase redirects to the AgentCore callback URL:

```
https://bedrock-agentcore.../identities/oauth2/callback/<provider-uuid>?code=<auth_code>&state=...
```

---

### Step 5 — AgentCore stores the code

AgentCore receives the authorization code and stores it against the session. It then redirects the browser to `SITE_URL/callback`:

```
https://your-app-url.com/callback?session_id=<sessionUri>
```

> AgentCore does **not** exchange the code yet — it waits for `CompleteResourceTokenAuth`.

---

### Step 6 — App completes the exchange (`GET /callback`)

The server handles this immediately (before the authorization code expires):

1. Calls `GetWorkloadAccessTokenForUserIdCommand` → fresh `workloadAccessToken`
2. Calls `CompleteResourceTokenAuthCommand(sessionUri, userIdentifier)`
   - AgentCore calls Supabase's token endpoint with the stored code and PKCE verifier
   - Supabase returns an `access_token`
   - AgentCore stores it in the vault keyed by `(workload, userId, credentialProvider, scopes)`
3. Calls `GetResourceOauth2TokenCommand` (no `sessionUri`)
   - AgentCore finds the cached token and returns `accessToken`

---

### Sequence Diagram

```
Browser          Express App          AgentCore          Supabase
   |                  |                    |                  |
   |--- POST /login ->|                    |                  |
   |                  |-- password grant ->|                  |
   |                  |                   (Supabase auth API) |
   |<-- set cookie ---|                    |                  |
   |                  |                    |                  |
   |-- GET /auth-url->|                    |                  |
   |                  |--GetWorkloadToken->|                  |
   |                  |<-workloadToken-----|                  |
   |                  |--GetResourceOauth2Token-------------->|
   |                  |  [no cached token]                    |
   |                  |<-authorizationUrl + sessionUri--------|
   |<-authorizationUrl|                    |                  |
   |                  |                    |                  |
   |----navigate to authorizationUrl------>|                  |
   |                  |                    |--redirect------->|
   |<--------------------------------------redirect-----------| (authorization_id created)
   |----Supabase hosted login/consent UI (if needed) ----->  |
   |<------redirect to AgentCore callbackUrl---------------|  |
   |                  |          code stored by AgentCore     |
   |<-redirect to SITE_URL/callback?session_id=...-|          |
   |                  |                    |                  |
   |-- GET /callback->|                    |                  |
   |                  |--CompleteResourceTokenAuth----------->|
   |                  |                    |--POST /token---->|
   |                  |                    |<-access_token----|
   |                  |                    | (stored in vault)|
   |                  |--GetResourceOauth2Token (cached)----->|
   |                  |<-accessToken--------------------------|
   |<-OAuth complete--|                    |                  |
   |                  |                    |                  |
   |-- GET /auth-url->|  [second click]    |                  |
   |                  |--GetResourceOauth2Token (cached)----->|
   |                  |<-accessToken--------------------------|
   |<-accessToken-----|                    |                  |
```

---

## Known Limitations

- **`openid` scope is not supported** — Supabase projects using HS256 JWT signing cannot generate ID tokens. Only request `email`, `profile`, etc.
- **Authorization code is short-lived** — `CompleteResourceTokenAuth` must be called promptly after the `session_id` redirect lands.
- **Service-linked workloads cannot be used** — only workload identities not linked to an AgentCore runtime can issue tokens via `GetWorkloadAccessTokenForUserId`.
- **In-memory PKCE state** — app login sessions are stored in a cookie but the user must re-login if the server restarts.
