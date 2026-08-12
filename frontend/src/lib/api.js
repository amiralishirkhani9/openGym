// Platform sniff. This file used to hold the backend fetch wrapper and the
// WebAuthn passkey ceremonies; the single-user build has no accounts and no
// server, so all that is gone and only the UA check remains.
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)
