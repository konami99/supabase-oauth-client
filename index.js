import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from "express";
import cookieParser from "cookie-parser";
import { BedrockAgentCoreClient, GetWorkloadAccessTokenForUserIdCommand, GetResourceOauth2TokenCommand, CompleteResourceTokenAuthCommand } from "@aws-sdk/client-bedrock-agentcore";
import { jwtVerify } from 'jose';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

const agentCoreClient = new BedrockAgentCoreClient({ region: process.env.AWS_REGION || "us-west-2" });
const supabase = createClient(`https://${process.env.PROJECT_REF}.supabase.co`, process.env.SUPABASE_ANON_KEY);

const JWT_SECRET = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);

async function getUserIdFromJwt(jwt) {
  const { payload } = await jwtVerify(jwt, JWT_SECRET);
  return payload.sub;
}

function decodeJwtPayload(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
}

async function requireAuth(req, res, next) {
  const jwt = req.cookies.supabase_jwt;
  if (!jwt) return res.status(401).json({ error: "Not logged in" });
  try {
    req.userId = await getUserIdFromJwt(jwt);
    next();
  } catch (err) {
    console.error("requireAuth failed:", err.message);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get("/me", requireAuth, (req, res) => {
  res.json({ userId: req.userId });
});

app.get("/debug-token", (req, res) => {
  const jwt = req.cookies.supabase_jwt;
  if (!jwt) return res.status(401).json({ error: "No token" });
  res.json(decodeJwtPayload(jwt));
});

app.post("/logout", (_req, res) => {
  res.clearCookie("supabase_jwt");
  res.json({ ok: true });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.cookie("supabase_jwt", data.session.access_token, { httpOnly: true, sameSite: "lax", secure: SITE_URL.startsWith("https") });
  res.json({ ok: true });
});

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
      return res.json({ accessToken: result.accessToken });
    }

    res.json({ authorizationUrl: result.authorizationUrl });
  } catch (err) {
    console.error("auth-url error:", err);
    res.status(500).json({ error: err.name, message: err.message });
  }
});

app.get("/callback", async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).send("Missing session_id");

  const jwt = req.cookies.supabase_jwt;
  if (!jwt) return res.status(401).send("Not logged in");

  let userId;
  try {
    userId = await getUserIdFromJwt(jwt);
  } catch (err) {
    console.error("callback JWT verification failed:", err.message);
    return res.status(401).send("Invalid or expired token");
  }

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
