import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from "cookie-parser";
import express from "express";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cookieParser());

const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get("/config", (_req, res) => {
  res.json({
    projectRef: process.env.PROJECT_REF,
    clientId: process.env.CLIENT_ID,
    redirectUri: process.env.REDIRECT_URI,
  });
});

app.get("/callback", async (req, res) => {
  console.log(req.query);

  const { code } = req.query;
  if (!code) return res.send("No code received");

  const codeVerifier = req.cookies.code_verifier;

  const tokenRes = await axios.post(
    `https://${process.env.PROJECT_REF}.supabase.co/auth/v1/oauth/token`,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: process.env.CLIENT_ID,
      redirect_uri: process.env.REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  console.log(tokenRes.data);
  res.send("OK");
});

app.listen(PORT, () => {
  console.log(`Client App running on ${SITE_URL}`);
});
