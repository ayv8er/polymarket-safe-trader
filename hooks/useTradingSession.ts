import { useConnection, useWalletClient } from "wagmi";
import { useState, useCallback, useEffect } from "react";

import useUserApiCredentials from "@/hooks/useUserApiCredentials";
import useTokenApprovals from "@/hooks/useTokenApprovals";
import useSafeDeployment from "@/hooks/useSafeDeployment";
import useRelayClient from "@/hooks/useRelayClient";

import {
  loadSession,
  saveSession,
  clearSession as clearStoredSession,
  TradingSession,
  SessionStep,
} from "@/utils/session";

// This is the coordination hook that manages the user's trading session
// It orchestrates the steps for initializing both the clob and relay clients
// It creates, stores, and loads the user's L2 credentials for the trading session (API credentials)
// It deploys the Safe and sets token approvals for the CTF Exchange

export default function useTradingSession() {
  const [tradingSession, setTradingSession] = useState<TradingSession | null>(
    null
  );
  const [currentStep, setCurrentStep] = useState<SessionStep>("idle");
  const [sessionError, setSessionError] = useState<Error | null>(null);

  const { data: walletClient } = useWalletClient();
  const { address: eoaAddress } = useConnection();
  const { createOrDeriveUserApiCredentials } = useUserApiCredentials();
  const { checkAllTokenApprovals, setAllTokenApprovals } = useTokenApprovals();
  const { derivedSafeAddressFromEoa, isSafeDeployed, deploySafe } =
    useSafeDeployment(eoaAddress);
  const { relayClient, initializeRelayClient, clearRelayClient } =
    useRelayClient(eoaAddress);

  // Step 0: Always check for an existing trading session when the wallet is connected using
  // a custom session object from localStorage to track the status of the user's trading session
  useEffect(() => {
    if (!eoaAddress) {
      setTradingSession(null);
      setCurrentStep("idle");
      setSessionError(null);
      return;
    }

    const stored = loadSession(eoaAddress);
    // Always set session (even if null) to clear previous wallet's session
    setTradingSession(stored);

    // Reset state when switching wallets
    if (!stored) {
      setCurrentStep("idle");
      setSessionError(null);
    }
  }, [eoaAddress]);

  // This effect restores the relay client when session exists and wallet is ready
  useEffect(() => {
    if (tradingSession && !relayClient && eoaAddress && walletClient) {
      initializeRelayClient().catch((err) => {
        console.error("Failed to restore relay client:", err);
      });
    }
  }, [
    tradingSession,
    relayClient,
    eoaAddress,
    walletClient,
    initializeRelayClient,
  ]);

  // The core function that orchestrates the trading session initialization
  const initializeTradingSession = useCallback(async () => {
    if (!eoaAddress) {
      throw new Error("Wallet not connected");
    }

    setCurrentStep("checking");
    setSessionError(null);

    try {
      // Step 0: Load existing session to start checking what steps
      // the user has already completed in their trading session
      const existingSession = loadSession(eoaAddress);

      // Step 1: Initializes relayClient with the user's EOA signer and
      // builder's API credentials (via remote signing server) for order attribution
      const initializedRelayClient = await initializeRelayClient();

      // Step 2: Get Safe address (deterministic derivation from EOA)
      if (!derivedSafeAddressFromEoa) {
        throw new Error("Failed to derive Safe address");
      }

      // Step 3: Check if Safe is deployed
      let isDeployed = await isSafeDeployed(
        initializedRelayClient,
        derivedSafeAddressFromEoa
      );

      // Step 4: Deploy Safe if not already deployed
      if (!isDeployed) {
        setCurrentStep("deploying");
        await deploySafe(initializedRelayClient);
      }

      // Step 5: Get User API Credentials (derive or create)
      // and store them in the custom session object
      let apiCreds = existingSession?.apiCredentials;
      if (
        !existingSession?.hasApiCredentials ||
        !apiCreds ||
        !apiCreds.key ||
        !apiCreds.secret ||
        !apiCreds.passphrase
      ) {
        setCurrentStep("credentials");
        apiCreds = await createOrDeriveUserApiCredentials();
      }

      // Step 6: Set all required token approvals for trading
      setCurrentStep("approvals");
      const approvalStatus = await checkAllTokenApprovals(
        derivedSafeAddressFromEoa
      );

      let hasApprovals = false;
      if (approvalStatus.allApproved) {
        hasApprovals = true;
      } else {
        hasApprovals = await setAllTokenApprovals(initializedRelayClient);
      }

      // Step 7: Create custom session object
      const newSession: TradingSession = {
        eoaAddress: eoaAddress,
        safeAddress: derivedSafeAddressFromEoa,
        isSafeDeployed: true,
        hasApiCredentials: true,
        hasApprovals,
        apiCredentials: apiCreds,
        lastChecked: Date.now(),
      };

      setTradingSession(newSession);
      saveSession(eoaAddress, newSession);

      setCurrentStep("complete");
    } catch (err) {
      console.error("Session initialization error:", err);
      const error = err instanceof Error ? err : new Error("Unknown error");
      setSessionError(error);
      setCurrentStep("idle");
    }
  }, [
    eoaAddress,
    relayClient,
    derivedSafeAddressFromEoa,
    isSafeDeployed,
    deploySafe,
    createOrDeriveUserApiCredentials,
  ]);

  // This function clears the trading session and resets the state
  const endTradingSession = useCallback(() => {
    if (!eoaAddress) return;

    clearStoredSession(eoaAddress);
    setTradingSession(null);
    clearRelayClient();
    setCurrentStep("idle");
    setSessionError(null);
  }, [eoaAddress, clearRelayClient]);

  return {
    tradingSession,
    currentStep,
    sessionError,
    isTradingSessionComplete:
      tradingSession?.isSafeDeployed &&
      tradingSession?.hasApiCredentials &&
      tradingSession?.hasApprovals,
    initializeTradingSession,
    endTradingSession,
    relayClient,
  };
}
