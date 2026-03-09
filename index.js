import 'dotenv/config';
import path from 'path';
import { randomUUID } from 'crypto';
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

function getOrCreateSessionId(req, res) {
  let sessionId = req.cookies.session_id;
  if (!sessionId) {
    sessionId = randomUUID();
    res.cookie("session_id", sessionId, { httpOnly: true, sameSite: "lax", secure: SITE_URL.startsWith("https") });
  }
  return sessionId;
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get("/auth-url", async (req, res) => {
  const userId = getOrCreateSessionId(req, res);
  try {
    const { workloadAccessToken } = await agentCoreClient.send(
      new GetWorkloadAccessTokenForUserIdCommand({
        workloadName: process.env.WORKLOAD_NAME,
        userId,
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

  const userId = req.cookies.session_id;
  if (!userId) return res.status(400).send("No session cookie — cannot complete auth");

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
