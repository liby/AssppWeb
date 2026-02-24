import { Srp, Mode, Client, util, Hash } from "@foxt/js-srp";
import { appleRequest } from "./request";

// iCloud Web widget key — public, used by Apple's web auth flows
const WIDGET_KEY =
  "d39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d";

const IDMSA_HOST = "idmsa.apple.com";

// Browser-like UA required by IDMSA (Configurator UA is rejected)
const IDMSA_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

type SRPProtocol = "s2k" | "s2k_fo";

export interface TrustedPhoneNumber {
  id: number;
  numberWithDialCode: string;
  pushMode: string;
}

export interface IdmsaSession {
  sessionId: string;
  scnt: string;
}

export interface PhoneNumbersResult {
  trustedPhoneNumbers: TrustedPhoneNumber[];
  securityCodeCooldown: boolean;
  tooManyCodesSent: boolean;
  securityCodeLocked: boolean;
}

function idmsaHeaders(session?: IdmsaSession): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": IDMSA_UA,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Apple-Widget-Key": WIDGET_KEY,
    "X-Apple-OAuth-Client-Id": WIDGET_KEY,
    "X-Apple-OAuth-Client-Type": "firstPartyAuth",
    "X-Apple-OAuth-Redirect-URI": "https://www.icloud.com",
    "X-Apple-OAuth-Require-Grant-Code": "true",
    "X-Apple-OAuth-Response-Mode": "web_message",
    "X-Apple-OAuth-Response-Type": "code",
    "X-Apple-OAuth-State": `auth-${crypto.randomUUID()}`,
    Origin: "https://www.icloud.com",
    Referer: "https://www.icloud.com/",
  };
  if (session) {
    headers["X-Apple-ID-Session-Id"] = session.sessionId;
    headers["scnt"] = session.scnt;
  }
  return headers;
}

/**
 * Derive password bytes using Apple's s2k/s2k_fo protocol.
 *
 * s2k:    PBKDF2(SHA256(password), salt, iterations, 32)
 * s2k_fo: PBKDF2(hex(SHA256(password)).utf8bytes, salt, iterations, 32)
 */
async function derivePassword(
  protocol: SRPProtocol,
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passBytes = encoder.encode(password);
  const passHashBuf = await crypto.subtle.digest("SHA-256", passBytes);
  let passHash = new Uint8Array(passHashBuf);

  if (protocol === "s2k_fo") {
    const hexStr = util.toHex(passHash);
    passHash = encoder.encode(hexStr);
  }

  const importedKey = await crypto.subtle.importKey(
    "raw",
    passHash,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, iterations },
    importedKey,
    256,
  );

  return new Uint8Array(derivedBits);
}

function b64Encode(buf: Uint8Array): string {
  let binary = "";
  for (const byte of buf) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function b64Decode(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Sign in to IDMSA using SRP-6a to obtain session tokens for SMS requests.
 * Uses Apple's GSA mode SRP with /signin/init + /signin/complete.
 */
export async function idmsaSignin(
  email: string,
  password: string,
): Promise<IdmsaSession> {
  const encoder = new TextEncoder();
  const srp = new Srp(Mode.GSA, Hash.SHA256, 2048);

  // Create SRP client with empty password placeholder (will be replaced after init)
  const client: Client = await srp.newClient(
    encoder.encode(email),
    new Uint8Array(),
  );

  const A = util.bytesFromBigint(client.A);

  // Step 1: /signin/init — send client public ephemeral A
  const initResp = await appleRequest({
    host: IDMSA_HOST,
    path: "/appleauth/auth/signin/init",
    method: "POST",
    headers: idmsaHeaders(),
    body: JSON.stringify({
      a: b64Encode(A),
      accountName: email,
      protocols: ["s2k", "s2k_fo"],
    }),
  });

  if (initResp.status !== 200) {
    throw new Error(
      `IDMSA signin/init failed: HTTP ${initResp.status} ${initResp.statusText}`,
    );
  }

  const initData = JSON.parse(initResp.body) as {
    iteration: number;
    salt: string;
    protocol: SRPProtocol;
    b: string;
    c: string;
  };

  // Step 2: Derive password and compute SRP proofs
  const salt = b64Decode(initData.salt);
  const serverB = b64Decode(initData.b);
  const derivedKey = await derivePassword(
    initData.protocol,
    password,
    salt,
    initData.iteration,
  );

  // Replace the placeholder password with the derived key by mutating the
  // internal `p` property. This is necessary because salt/iterations are only
  // known after the /signin/init response, but SRP Client requires a password
  // at construction time. Fragile — may break if @foxt/js-srp changes internals.
  client.p = derivedKey;

  await client.generate(salt, serverB);
  const m1 = client.M;
  const m2 = await client.generateM2();

  // Step 3: /signin/complete — send proofs
  const completeResp = await appleRequest({
    host: IDMSA_HOST,
    path: "/appleauth/auth/signin/complete?isRememberMeEnabled=true",
    method: "POST",
    headers: idmsaHeaders(),
    body: JSON.stringify({
      accountName: email,
      c: initData.c,
      m1: b64Encode(m1),
      // Apple IDMSA requires the client to send M2 (server proof) alongside M1.
      // In standard SRP-6a, M2 is computed and sent by the server for the client
      // to verify. This is an Apple-specific deviation from the protocol.
      m2: b64Encode(m2),
      rememberMe: false,
      trustTokens: [],
    }),
  });

  // 409 = 2FA required (expected), 200 = success (no 2FA needed)
  if (completeResp.status !== 409 && completeResp.status !== 200) {
    throw new Error(
      `IDMSA signin/complete failed: HTTP ${completeResp.status} ${completeResp.statusText}`,
    );
  }

  const sessionId = completeResp.headers["x-apple-id-session-id"];
  const scnt = completeResp.headers["scnt"];

  if (!sessionId || !scnt) {
    throw new Error("IDMSA signin: missing session headers");
  }

  return { sessionId, scnt };
}

export async function idmsaGetPhoneNumbers(
  session: IdmsaSession,
): Promise<PhoneNumbersResult> {
  const resp = await appleRequest({
    host: IDMSA_HOST,
    path: "/appleauth/auth",
    method: "GET",
    headers: idmsaHeaders(session),
  });

  if (resp.status !== 200) {
    throw new Error(
      `IDMSA get auth info failed: HTTP ${resp.status} ${resp.statusText}`,
    );
  }

  const data = JSON.parse(resp.body);

  const trustedPhoneNumbers: TrustedPhoneNumber[] = (
    data.trustedPhoneNumbers ?? []
  ).map((p: Record<string, unknown>) => ({
    id: p.id as number,
    numberWithDialCode: p.numberWithDialCode as string,
    pushMode: p.pushMode as string,
  }));

  return {
    trustedPhoneNumbers,
    securityCodeCooldown:
      data.securityCode?.tooManyCodesSent === true ||
      data.securityCode?.securityCodeCooldown === true,
    tooManyCodesSent: data.securityCode?.tooManyCodesSent === true,
    securityCodeLocked: data.securityCode?.securityCodeLocked === true,
  };
}

export async function idmsaRequestSms(
  session: IdmsaSession,
  phoneId: number,
): Promise<void> {
  const resp = await appleRequest({
    host: IDMSA_HOST,
    path: "/appleauth/auth/verify/phone",
    method: "PUT",
    headers: idmsaHeaders(session),
    body: JSON.stringify({
      phoneNumber: { id: phoneId },
      mode: "sms",
    }),
  });

  // 200 = success, 202 = accepted (code sent)
  if (resp.status !== 200 && resp.status !== 202) {
    throw new Error(
      `IDMSA SMS request failed: HTTP ${resp.status} ${resp.statusText}`,
    );
  }
}

/**
 * Verify an SMS verification code through IDMSA.
 * This must be called before submitting the code to MZFinance so that
 * Apple's auth system marks the 2FA challenge as satisfied.
 */
export async function idmsaVerifySmsCode(
  session: IdmsaSession,
  phoneId: number,
  code: string,
): Promise<void> {
  console.log(`[IDMSA] Verifying SMS code for phoneId=${phoneId}`);

  const resp = await appleRequest({
    host: IDMSA_HOST,
    path: "/appleauth/auth/verify/phone/securitycode",
    method: "POST",
    headers: idmsaHeaders(session),
    body: JSON.stringify({
      phoneNumber: { id: phoneId },
      securityCode: { code },
      mode: "sms",
    }),
  });

  console.log(`[IDMSA] verify/phone/securitycode → HTTP ${resp.status}`);
  console.log(`[IDMSA] Response headers:`, JSON.stringify(resp.headers, null, 2));
  if (resp.body) {
    console.log(`[IDMSA] Response body:`, resp.body.slice(0, 2000));
  }

  // 200 = verified, 204 = no-content success
  if (resp.status !== 200 && resp.status !== 204) {
    throw new Error(
      `IDMSA SMS verify failed: HTTP ${resp.status} ${resp.statusText}`,
    );
  }

  console.log(`[IDMSA] SMS code verified successfully`);
}

/**
 * Request a trust token after successful 2FA verification.
 * The trust token can optionally be stored for future sessions.
 */
export async function idmsaGetTrustToken(
  session: IdmsaSession,
): Promise<string> {
  console.log(`[IDMSA] Requesting trust token...`);

  const resp = await appleRequest({
    host: IDMSA_HOST,
    path: "/appleauth/auth/2sv/trust",
    method: "GET",
    headers: idmsaHeaders(session),
  });

  console.log(`[IDMSA] 2sv/trust → HTTP ${resp.status}`);
  console.log(`[IDMSA] Response headers:`, JSON.stringify(resp.headers, null, 2));
  if (resp.body) {
    console.log(`[IDMSA] Response body:`, resp.body.slice(0, 2000));
  }

  if (resp.status !== 200 && resp.status !== 204) {
    throw new Error(
      `IDMSA trust token request failed: HTTP ${resp.status} ${resp.statusText}`,
    );
  }

  const trustToken = resp.headers["x-apple-twosv-trust-token"] ?? "";
  console.log(`[IDMSA] Trust token obtained: ${trustToken ? `${trustToken.slice(0, 20)}...` : "(empty)"}`);
  return trustToken;
}
