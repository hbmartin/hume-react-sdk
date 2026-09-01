declare namespace NodeJS {
  interface ProcessEnv {
    readonly HUME_API_KEY?: string;
    readonly HUME_CONFIG_ID?: string;
    readonly HUME_SECRET_KEY?: string;
    readonly HUME_TOKEN_HOSTNAME?: string;
    readonly NEXT_PUBLIC_GEOCODE_API_KEY?: string;
    readonly NEXT_PUBLIC_HUME_VOICE_HOSTNAME?: string;
  }
}
