import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from "express";
import cookieParser from "cookie-parser";
import { BedrockAgentCoreClient, GetWorkloadAccessTokenForUserIdCommand, GetResourceOauth2TokenCommand, CompleteResourceTokenAuthCommand } from "@aws-sdk/client-bedrock-agentcore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

const agentCoreClient = new BedrockAgentCoreClient({ region: process.env.AWS_REGION || "us-west-2" });

function getUserIdFromJwt(jwt) {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  return payload.sub;
}

function requireAuth(req, res, next) {
  const jwt = req.cookies.supabase_jwt;
  if (!jwt) return res.status(401).json({ error: "Not logged in" });
  req.userId = getUserIdFromJwt(jwt);
  next();
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get("/me", requireAuth, (req, res) => {
  res.json({ userId: req.userId });
});

app.post("/logout", (_req, res) => {
  res.clearCookie("supabase_jwt");
  res.json({ ok: true });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const response = await fetch(
      `https://${process.env.PROJECT_REF}.supabase.co/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: process.env.SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || data.error || "Login failed");
    res.cookie("supabase_jwt", data.access_token, { httpOnly: true, sameSite: "lax", secure: SITE_URL.startsWith("https") });
    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Step 1: get AgentCore authorization URL (AgentCore generates PKCE internally)
app.get("/auth-url", requireAuth, async (req, res) => {
  try {
    const { workloadAccessToken } = await agentCoreClient.send(
      new GetWorkloadAccessTokenForUserIdCommand({
        workloadName: process.env.WORKLOAD_NAME,
        userId: req.userId,
      })
    );

    const result = await agentCoreClient.send(new GetResourceOauth2TokenCommand({
      workloadIdentityToken: workloadAccessToken,
      resourceCredentialProviderName: process.env.CREDENTIAL_PROVIDER_NAME,
      scopes: ["email"],
      oauth2Flow: "USER_FEDERATION",
      resourceOauth2ReturnUrl: `${SITE_URL}/callback`,
    }));

    if (result.accessToken) {
      // Token already cached in AgentCore vault
      return res.json({ accessToken: result.accessToken });
    }

    res.json({ authorizationUrl: result.authorizationUrl });
  } catch (err) {
    console.error("auth-url error:", err);
    res.status(500).json({ error: err.name, message: err.message });
  }
});

// Step 2: AgentCore redirects here after user approves consent; complete token exchange
app.get("/callback", async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).send("Missing session_id");

  const jwt = req.cookies.supabase_jwt;
  if (!jwt) return res.status(401).send("Not logged in");
  const userId = getUserIdFromJwt(jwt);

  try {
    const { workloadAccessToken } = await agentCoreClient.send(
      new GetWorkloadAccessTokenForUserIdCommand({
        workloadName: process.env.WORKLOAD_NAME,
        userId,
      })
    );

    await agentCoreClient.send(new CompleteResourceTokenAuthCommand({
      sessionUri: session_id,
      userIdentifier: { userId },
    }));

    const { accessToken } = await agentCoreClient.send(new GetResourceOauth2TokenCommand({
      workloadIdentityToken: workloadAccessToken,
      resourceCredentialProviderName: process.env.CREDENTIAL_PROVIDER_NAME,
      scopes: ["email"],
      oauth2Flow: "USER_FEDERATION",
      resourceOauth2ReturnUrl: `${SITE_URL}/callback`,
    }));

    console.log("accessToken:", accessToken);
    return res.send(`OAuth complete. accessToken: ${accessToken}`);
  } catch (err) {
    console.error("callback error:", err);
    return res.status(500).send(`OAuth completion failed: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Client App running on ${SITE_URL}`);
});
