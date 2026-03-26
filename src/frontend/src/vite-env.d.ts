/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GATEWAY_CANISTER_ID: string;
  readonly VITE_KEYVAULT_CANISTER_ID: string;
  readonly VITE_WALLET_CANISTER_ID: string;
  readonly VITE_IDENTITY_CANISTER_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
