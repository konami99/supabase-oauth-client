import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from "express";
import { BedrockAgentCoreClient, GetWorkloadAccessTokenForJWTCommand, GetResourceOauth2TokenCommand } from "@aws-sdk/client-bedrock-agentcore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

const agentCoreClient = new BedrockAgentCoreClient({ region: process.env.AWS_REGION || "us-west-2" });

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get("/auth-url", async (_req, res) => {
  try {
    const { workloadAccessToken } = await agentCoreClient.send(
      new GetWorkloadAccessTokenForJWTCommand({
        workloadName: process.env.WORKLOAD_NAME,
        userToken: process.env.USER_JWT,
      })
    );

    const command = new GetResourceOauth2TokenCommand({
      workloadIdentityToken: workloadAccessToken,
      resourceCredentialProviderName: "resource-provider-oauth-client-gzw1j",
      scopes: ["openid", "email"],
      oauth2Flow: "USER_FEDERATION",
      resourceOauth2ReturnUrl: SITE_URL,
    });

    const { authorizationUrl } = await agentCoreClient.send(command);
    console.log("authorizationUrl", authorizationUrl);
    res.json({ authorizationUrl });
  } catch (err) {
    console.error("auth-url error:", err);
    res.status(500).json({ error: err.name, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Client App running on ${SITE_URL}`);
});
