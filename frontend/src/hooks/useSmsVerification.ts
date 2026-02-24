import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  idmsaSignin,
  idmsaGetPhoneNumbers,
  idmsaRequestSms,
  idmsaVerifySmsCode,
  idmsaGetTrustToken,
} from "../apple/idmsa";
import { getErrorMessage } from "../utils/error";
import type { IdmsaSession, TrustedPhoneNumber } from "../apple/idmsa";

export interface SmsVerificationState {
  smsMode: boolean;
  smsLoading: boolean;
  phoneNumbers: TrustedPhoneNumber[];
  selectedPhoneId: number | null;
  smsSent: boolean;
  smsPhone: string | null;
  smsError: string | null;
  cooldown: boolean;
  tooManyCodes: boolean;
  codeLocked: boolean;
}

export interface SmsVerificationActions {
  initiateSms: () => Promise<void>;
  sendSms: (phoneId?: number) => Promise<void>;
  verifySmsCode: (code: string) => Promise<void>;
  resetSms: () => void;
  setSelectedPhoneId: (id: number) => void;
}

export function useSmsVerification(
  email: string,
  password: string,
): SmsVerificationState & SmsVerificationActions {
  const { t } = useTranslation();
  const sessionRef = useRef<IdmsaSession | null>(null);

  const [smsMode, setSmsMode] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const [phoneNumbers, setPhoneNumbers] = useState<TrustedPhoneNumber[]>([]);
  const [selectedPhoneId, setSelectedPhoneId] = useState<number | null>(null);
  const [smsSent, setSmsSent] = useState(false);
  const [smsPhone, setSmsPhone] = useState<string | null>(null);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(false);
  const [tooManyCodes, setTooManyCodes] = useState(false);
  const [codeLocked, setCodeLocked] = useState(false);

  const sendSms = useCallback(
    async (phoneId?: number) => {
      const session = sessionRef.current;
      if (!session) return;

      const targetId = phoneId ?? selectedPhoneId;
      if (targetId === null) return;

      setSmsLoading(true);
      setSmsError(null);

      try {
        await idmsaRequestSms(session, targetId);
        setSmsSent(true);
        setSelectedPhoneId(targetId);
        // Find display string for the sent phone
        const phone = phoneNumbers.find((p) => p.id === targetId);
        setSmsPhone(phone?.numberWithDialCode ?? null);
      } catch (err) {
        setSmsError(
          getErrorMessage(err, t("errors.auth.smsRequestFailed")),
        );
      } finally {
        setSmsLoading(false);
      }
    },
    [selectedPhoneId, phoneNumbers, t],
  );

  const initiateSms = useCallback(async () => {
    setSmsMode(true);
    setSmsLoading(true);
    setSmsError(null);
    setSmsSent(false);
    setSmsPhone(null);
    setCooldown(false);
    setTooManyCodes(false);
    setCodeLocked(false);

    try {
      // Step 1: IDMSA signin
      const session = await idmsaSignin(email, password);
      sessionRef.current = session;

      // Step 2: Get phone numbers and rate-limit status
      const result = await idmsaGetPhoneNumbers(session);

      if (result.securityCodeLocked) {
        setCodeLocked(true);
        setSmsLoading(false);
        return;
      }

      if (result.tooManyCodesSent) {
        setTooManyCodes(true);
        setSmsLoading(false);
        return;
      }

      if (result.securityCodeCooldown) {
        setCooldown(true);
        setSmsLoading(false);
        return;
      }

      const phones = result.trustedPhoneNumbers;
      setPhoneNumbers(phones);

      if (phones.length === 0) {
        setSmsError(t("errors.auth.noPhoneNumbers"));
        setSmsLoading(false);
        return;
      }

      // Step 3: Auto-send if only one phone number
      if (phones.length === 1) {
        setSelectedPhoneId(phones[0].id);
        await idmsaRequestSms(session, phones[0].id);
        setSmsSent(true);
        setSmsPhone(phones[0].numberWithDialCode);
        setSmsLoading(false);
        return;
      }

      // Multiple phones — let user choose
      setSelectedPhoneId(phones[0].id);
      setSmsLoading(false);
    } catch (err) {
      setSmsError(
        getErrorMessage(err, t("errors.auth.idmsaSigninFailed")),
      );
      setSmsLoading(false);
    }
  }, [email, password, t]);

  /**
   * Verify the SMS code through IDMSA, then optionally fetch a trust token.
   * Must be called after SMS was sent and before submitting to MZFinance.
   */
  const verifySmsCode = useCallback(
    async (code: string) => {
      const session = sessionRef.current;
      if (!session || selectedPhoneId === null) {
        console.error(`[SMS] verifySmsCode called without session or phoneId. session=${!!session}, phoneId=${selectedPhoneId}`);
        throw new Error("No active IDMSA session or phone selection");
      }

      // Step 1: Verify the code via IDMSA
      console.log(`[SMS] Step 1/2: Verifying code via IDMSA (phoneId=${selectedPhoneId})...`);
      try {
        await idmsaVerifySmsCode(session, selectedPhoneId, code);
        console.log(`[SMS] Step 1/2: IDMSA verification passed`);
      } catch (err) {
        console.error(`[SMS] Step 1/2: IDMSA verification failed:`, err);
        throw new Error(
          getErrorMessage(err, t("errors.auth.smsVerifyFailed")),
        );
      }

      // Step 2: Attempt to get a trust token (best-effort, not critical)
      console.log(`[SMS] Step 2/2: Requesting trust token...`);
      try {
        const token = await idmsaGetTrustToken(session);
        console.log(`[SMS] Step 2/2: Trust token ${token ? "obtained" : "empty (but not fatal)"}`);
      } catch (err) {
        console.warn(`[SMS] Step 2/2: Trust token failed (non-fatal):`, err);
      }

      console.log(`[SMS] IDMSA verification complete, proceeding to MZFinance...`);
    },
    [selectedPhoneId, t],
  );

  const resetSms = useCallback(() => {
    setSmsMode(false);
    setSmsLoading(false);
    setPhoneNumbers([]);
    setSelectedPhoneId(null);
    setSmsSent(false);
    setSmsPhone(null);
    setSmsError(null);
    setCooldown(false);
    setTooManyCodes(false);
    setCodeLocked(false);
    sessionRef.current = null;
  }, []);

  return {
    smsMode,
    smsLoading,
    phoneNumbers,
    selectedPhoneId,
    smsSent,
    smsPhone,
    smsError,
    cooldown,
    tooManyCodes,
    codeLocked,
    initiateSms,
    sendSms,
    verifySmsCode,
    resetSms,
    setSelectedPhoneId,
  };
}
