import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Spinner from "../common/Spinner";
import { useAccounts } from "../../hooks/useAccounts";
import { useSmsVerification } from "../../hooks/useSmsVerification";
import { useToastStore } from "../../store/toast";
import { authenticate, AuthenticationError } from "../../apple/authenticate";
import { getErrorMessage } from "../../utils/error";
import { generateDeviceId } from "../../apple/config";

export default function AddAccountForm() {
  const navigate = useNavigate();
  const { addAccount } = useAccounts();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [deviceId, setDeviceId] = useState(() => generateDeviceId());
  const [needsCode, setNeedsCode] = useState(false);
  const [loading, setLoading] = useState(false);

  const sms = useSmsVerification(email, password);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const cleanedDeviceId = deviceId.replace(/[: ]/g, "");
      setDeviceId(cleanedDeviceId);

      // If SMS was used, verify the code through IDMSA first
      const smsWasVerified = sms.smsSent && needsCode && code;
      if (smsWasVerified) {
        await sms.verifySmsCode(code);
      }

      const account = await authenticate(
        email,
        password,
        needsCode && code ? code : undefined,
        undefined,
        cleanedDeviceId,
        !!smsWasVerified,
      );
      await addAccount(account);
      addToast(t("accounts.addForm.addSuccess"), "success");
      navigate("/accounts");
    } catch (err) {
      if (err instanceof AuthenticationError && err.codeRequired) {
        setNeedsCode(true);
        addToast(err.message, "error");
      } else {
        addToast(
          getErrorMessage(err, t("accounts.addForm.authFailed")),
          "error",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageContainer title={t("accounts.addForm.title")}>
      <div>
        <form onSubmit={handleSubmit} className="space-y-6">
          <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-6 space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("accounts.addForm.email")}
              </label>
              <input
                id="email"
                type="text"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                placeholder={t("accounts.addForm.emailPlaceholder")}
                className="block w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:text-gray-500 transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("accounts.addForm.password")}
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className="block w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:text-gray-500 transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="deviceId"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("accounts.addForm.deviceId")}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="deviceId"
                  type="text"
                  required
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  disabled={loading || needsCode}
                  className="block flex-1 min-w-0 h-[42px] rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:text-gray-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setDeviceId(generateDeviceId())}
                  disabled={loading || needsCode}
                  className="h-[42px] px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-700 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap flex-shrink-0"
                >
                  {t("accounts.addForm.randomize")}
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t("accounts.addForm.deviceIdHelp")}
              </p>
            </div>

            {needsCode && (
              <div>
                <label
                  htmlFor="code"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  {t("accounts.addForm.code")}
                </label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={loading}
                  placeholder={t("accounts.addForm.codePlaceholder")}
                  className="block w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:text-gray-500 transition-colors"
                  autoFocus
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {sms.smsSent
                    ? t("accounts.addForm.smsHelp")
                    : t("accounts.addForm.codeHelp")}
                </p>

                {/* SMS verification controls */}
                <div className="mt-3">
                  {!sms.smsMode ? (
                    <button
                      type="button"
                      onClick={sms.initiateSms}
                      disabled={loading || sms.smsLoading || !email || !password}
                      className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {t("accounts.addForm.useSms")}
                    </button>
                  ) : (
                    <div className="space-y-2">
                      {sms.smsLoading && (
                        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                          <Spinner />
                          {t("accounts.addForm.sendingSms")}
                        </div>
                      )}

                      {sms.smsError && (
                        <p className="text-sm text-red-600 dark:text-red-400">
                          {sms.smsError}
                        </p>
                      )}

                      {sms.codeLocked && (
                        <p className="text-sm text-red-600 dark:text-red-400">
                          {t("accounts.addForm.codeLocked")}
                        </p>
                      )}

                      {sms.tooManyCodes && !sms.codeLocked && (
                        <p className="text-sm text-amber-600 dark:text-amber-400">
                          {t("accounts.addForm.tooManyCodes")}
                        </p>
                      )}

                      {sms.cooldown && !sms.tooManyCodes && !sms.codeLocked && (
                        <p className="text-sm text-amber-600 dark:text-amber-400">
                          {t("accounts.addForm.cooldown")}
                        </p>
                      )}

                      {sms.smsSent && sms.smsPhone && (
                        <p className="text-sm text-green-600 dark:text-green-400">
                          {t("accounts.addForm.smsSent", { phone: sms.smsPhone })}
                        </p>
                      )}

                      {/* Phone number selection (multiple phones) */}
                      {!sms.smsLoading &&
                        !sms.smsSent &&
                        sms.phoneNumbers.length > 1 && (
                          <div className="space-y-2">
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              {t("accounts.addForm.selectPhone")}
                            </p>
                            {sms.phoneNumbers.map((phone) => (
                              <label
                                key={phone.id}
                                className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer"
                              >
                                <input
                                  type="radio"
                                  name="sms-phone"
                                  checked={sms.selectedPhoneId === phone.id}
                                  onChange={() => sms.setSelectedPhoneId(phone.id)}
                                  className="text-blue-600 focus:ring-blue-500"
                                />
                                {phone.numberWithDialCode}
                              </label>
                            ))}
                            <button
                              type="button"
                              onClick={() => sms.sendSms()}
                              disabled={sms.smsLoading || sms.selectedPhoneId === null}
                              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
                            >
                              {sms.smsLoading && <Spinner />}
                              {t("accounts.addForm.sendCode")}
                            </button>
                          </div>
                        )}

                      <button
                        type="button"
                        onClick={sms.resetSms}
                        disabled={sms.smsLoading}
                        className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50 transition-colors"
                      >
                        {t("accounts.addForm.backToDevice")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {loading && <Spinner />}
              {needsCode
                ? t("accounts.addForm.verify")
                : t("accounts.addForm.signIn")}
            </button>
            <button
              type="button"
              onClick={() => navigate("/accounts")}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              {t("accounts.addForm.cancel")}
            </button>
          </div>
        </form>
      </div>
    </PageContainer>
  );
}
