import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

const CONTACTS_URL = (mailbox) =>
  `https://graph.microsoft.com/v1.0/users/${mailbox}/contacts?$top=999`;

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Build a client_assertion JWT signed with the private key.
 * Required claims: iss, sub, aud, exp, nbf, jti
 * Header must include x5t (base64url SHA-1 thumbprint of the cert).
 */
function buildClientAssertion({ tenantId, clientId, certKeyPath, certThumbprint }) {
  const privateKey = fs.readFileSync(certKeyPath, "utf8");

  // Convert hex thumbprint to base64url
  const thumbBuf = Buffer.from(certThumbprint.replace(/:/g, ""), "hex");
  const x5t = thumbBuf.toString("base64url");

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: TOKEN_URL(tenantId),
    iss: clientId,
    sub: clientId,
    nbf: now,
    exp: now + 600, // 10 minutes
    jti: crypto.randomUUID(),
  };

  return jwt.sign(payload, privateKey, {
    algorithm: "RS256",
    header: { x5t },
  });
}

export async function getToken(config) {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const useCert = config.certKeyPath && config.certThumbprint;
  const body = new URLSearchParams({
    client_id: config.clientId,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  if (useCert) {
    const assertion = buildClientAssertion(config);
    body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    body.set("client_assertion", assertion);
    console.log("[auth] Using certificate-based authentication");
  } else {
    body.set("client_secret", config.clientSecret);
    console.log("[auth] Using client secret authentication");
  }

  const res = await fetch(TOKEN_URL(config.tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Expire 5 minutes early to be safe
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return cachedToken;
}

export async function fetchContacts(config) {
  const token = await getToken(config);

  const res = await fetch(CONTACTS_URL(config.mailbox), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Contacts fetch failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.value || [];
}
