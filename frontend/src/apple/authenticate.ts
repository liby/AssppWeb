import type { Account, Cookie } from "../types";
import { appleRequest } from "./request";
import { parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, defaultAuthURL } from "./bag";
import i18n from "../i18n";

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = "",
  smsVerified: boolean = false,
): Promise<Account> {
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = "";
  let lastError: Error | null = null;

  const defaultAuthEndpoint = new URL(defaultAuthURL);
  defaultAuthEndpoint.searchParams.set("guid", deviceId);
  let requestHost = defaultAuthEndpoint.hostname;
  let requestPath = `${defaultAuthEndpoint.pathname}${defaultAuthEndpoint.search}`;

  const bag = await fetchBag(deviceId);
  const authEndpoint = new URL(bag.authURL);
  authEndpoint.searchParams.set("guid", deviceId);
  requestHost = authEndpoint.hostname;
  requestPath = `${authEndpoint.pathname}${authEndpoint.search}`;

  let currentAttempt = 0;
  let redirectAttempt = 0;

  console.log(`[MZFinance] Starting auth: host=${requestHost}, hasCode=${!!code}, smsVerified=${smsVerified}`);

  while (currentAttempt < 2 && redirectAttempt <= 3) {
    currentAttempt++;

    try {
      // When SMS-verified via IDMSA, send plain password (2FA already satisfied)
      // When using device push code, concatenate code to password (MZFinance convention)
      const useCode = code && !smsVerified;
      const passwordValue = useCode ? `${password}${code}` : password;

      const params = new URLSearchParams();
      params.set("appleId", email);
      params.set("attempt", useCode ? "2" : "4");
      params.set("guid", deviceId);
      params.set("password", passwordValue);
      params.set("rmp", "0");
      params.set("why", "signIn");

      console.log(`[MZFinance] Password mode: ${useCode ? "password+code" : smsVerified ? "password-only (SMS verified via IDMSA)" : "password-only (no code)"}`);

      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
      };

      console.log(`[MZFinance] POST ${requestHost}${requestPath} (attempt=${currentAttempt}, redirect=${redirectAttempt})`);

      const response = await appleRequest({
        method: "POST",
        host: requestHost,
        path: requestPath,
        headers,
        body: params.toString(),
        cookies,
      });

      console.log(`[MZFinance] → HTTP ${response.status} ${response.statusText}`);
      console.log(`[MZFinance] Response headers: pod=${response.headers["pod"] ?? "(none)"}, storefront=${response.headers["x-set-apple-store-front"] ?? "(none)"}`);

      cookies = extractAndMergeCookies(response.rawHeaders, cookies);

      // Read store front
      const storeHeader = response.headers["x-set-apple-store-front"];
      if (storeHeader) {
        const parts = storeHeader.split("-");
        if (parts[0]) {
          storeFront = parts[0];
        }
      }

      // Read pod
      const podHeader = response.headers["pod"];
      const pod = podHeader || undefined;

      // Handle redirect
      if (response.status === 302) {
        const location = response.headers["location"];
        console.log(`[MZFinance] 302 redirect → ${location}`);
        if (!location) {
          throw new Error(i18n.t("errors.auth.redirectLocation"));
        }
        const url = new URL(location);
        requestHost = url.hostname;
        requestPath = url.pathname + url.search;
        currentAttempt--;
        redirectAttempt++;
        continue;
      }

      // Handle 404 as 2FA requirement (aligns with blacktop/ipsw reference)
      if (response.status === 404 && !code) {
        console.log(`[MZFinance] 404 → treating as 2FA requirement`);
        throw new AuthenticationError(
          i18n.t("errors.auth.requiresVerification"),
          true,
        );
      }

      // Handle non-plist responses (e.g. 403 with empty body)
      if (!response.body.trim()) {
        console.warn(`[MZFinance] Empty body with HTTP ${response.status}`);
        throw new Error(
          i18n.t("errors.auth.emptyBody", { status: response.status }),
        );
      }

      const dict = parsePlist(response.body) as Record<string, any>;

      console.log(`[MZFinance] Plist response: failureType=${JSON.stringify(dict.failureType)}, customerMessage=${JSON.stringify(dict.customerMessage)}, hasAccountInfo=${!!dict.accountInfo}, hasPasswordToken=${!!dict.passwordToken}`);
      if (dict.dialog) {
        console.log(`[MZFinance] Dialog: ${JSON.stringify(dict.dialog)}`);
      }

      // Account locked — do NOT retry (retrying worsens the lock)
      if (dict.failureType === "5020") {
        const lockMsg = (dict.dialog as Record<string, any>)?.explanation ?? dict.customerMessage ?? "Account locked";
        console.error(`[MZFinance] Account locked (5020) — aborting, no retry`);
        throw new Error(lockMsg);
      }

      // Retry once on -5000 (invalid credentials) — known Apple first-request quirk
      if (dict.failureType === "-5000" && currentAttempt === 1) {
        console.log(`[MZFinance] Got -5000 on first attempt, retrying...`);
        continue;
      }

      // Check for 2FA requirement
      if (
        dict.failureType === "" &&
        !code &&
        dict.customerMessage === "MZFinance.BadLogin.Configurator_message"
      ) {
        console.log(`[MZFinance] 2FA required (BadLogin.Configurator_message)`);
        throw new AuthenticationError(
          i18n.t("errors.auth.requiresVerification"),
          true,
        );
      }

      const failureMessage =
        (dict.dialog as Record<string, any>)?.explanation ??
        dict.customerMessage;

      const accountInfo = dict.accountInfo as Record<string, any>;
      if (!accountInfo) {
        console.error(`[MZFinance] No accountInfo in response. failureMessage=${JSON.stringify(failureMessage)}`);
        console.error(`[MZFinance] Full plist keys: ${Object.keys(dict).join(", ")}`);
        throw new Error(
          failureMessage ?? i18n.t("errors.auth.missingAccountInfo"),
        );
      }

      const address = accountInfo.address as Record<string, any>;
      if (!address) {
        throw new Error(failureMessage ?? i18n.t("errors.auth.missingAddress"));
      }

      const account: Account = {
        email,
        password,
        appleId: (accountInfo.appleId as string) ?? "",
        store: storeFront,
        firstName: (address.firstName as string) ?? "",
        lastName: (address.lastName as string) ?? "",
        passwordToken: (dict.passwordToken as string) ?? "",
        directoryServicesIdentifier: String(dict.dsPersonId ?? ""),
        cookies,
        deviceIdentifier: deviceId,
        pod,
      };

      console.log(`[MZFinance] Auth success: appleId=${account.appleId}, dsid=${account.directoryServicesIdentifier}, pod=${pod ?? "(none)"}, store=${storeFront}`);
      return account;
    } catch (e) {
      if (e instanceof AuthenticationError) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      console.error(`[MZFinance] Attempt ${currentAttempt} error:`, lastError.message);
    }
  }

  throw lastError ?? new Error(i18n.t("errors.auth.unknownReason"));
}
