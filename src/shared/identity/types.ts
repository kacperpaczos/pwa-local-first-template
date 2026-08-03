export type SeaPair = {
  pub: string;
  priv: string;
  epub: string;
  epriv: string;
};

export type IdentityPayload = {
  v: 1;
  pair: SeaPair;
};

export const IDENTITY_STORAGE_KEY = "pwa-lf-identity-v1";
