import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from "express";
import { BedrockAgentCoreClient, GetWorkloadAccessTokenForUserIdCommand, GetResourceOauth2TokenCommand, CompleteResourceTokenAuthCommand } from "@aws-sdk/client-bedrock-agentcore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

const agentCoreClient = new BedrockAgentCoreClient({ region: process.env.AWS_REGION || "us-west-2" });

app.get("/", async (req, res) => {
  const { session_id } = req.query;

  if (session_id) {
    try {
      const { workloadAccessToken } = await agentCoreClient.send(
        new GetWorkloadAccessTokenForUserIdCommand({
          workloadName: process.env.WORKLOAD_NAME,
          userId: process.env.USER_ID,
        })
      );

      // Trigger the code exchange while the authorization code is still fresh
      const completeResult = await agentCoreClient.send(new CompleteResourceTokenAuthCommand({
        sessionUri: session_id,
        userIdentifier: { userId: process.env.USER_ID },
      }));
      console.log("CompleteResourceTokenAuth result:", completeResult);

      // Retrieve the now-stored token
      const { accessToken } = await agentCoreClient.send(new GetResourceOauth2TokenCommand({
        workloadIdentityToken: workloadAccessToken,
        resourceCredentialProviderName: "resource-provider-oauth-client-gzw1j",
        scopes: ["email"],
        oauth2Flow: "USER_FEDERATION",
        resourceOauth2ReturnUrl: SITE_URL,
      }));
      console.log("accessToken:", accessToken);
      return res.send(`OAuth complete. accessToken: ${accessToken}`);
    } catch (err) {
      console.error("token retrieval error:", err);
      return res.status(500).send(`OAuth completion failed: ${err.message}`);
    }
  }

  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get("/auth-url", async (_req, res) => {
  try {
    const { workloadAccessToken } = await agentCoreClient.send(
      new GetWorkloadAccessTokenForUserIdCommand({
        workloadName: process.env.WORKLOAD_NAME,
        userId: process.env.USER_ID,
      })
    );

    const command = new GetResourceOauth2TokenCommand({
      workloadIdentityToken: workloadAccessToken,
      resourceCredentialProviderName: "resource-provider-oauth-client-gzw1j",
      scopes: ["email"],
      oauth2Flow: "USER_FEDERATION",
      resourceOauth2ReturnUrl: SITE_URL,
    });

    const { authorizationUrl } = await agentCoreClient.send(command);
    console.log("authorizationUrl>>>>>>>>>>>>>>>>>>>>>>>", authorizationUrl);
    res.json({ authorizationUrl });
  } catch (err) {
    console.error("auth-url error:", err);
    res.status(500).json({ error: err.name, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Client App running on ${SITE_URL}`);
});
