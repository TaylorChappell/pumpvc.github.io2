# Secure frontend rewrite

This frontend is intentionally a thin client.

## What changed
- No raw private keys stored in localStorage
- No sensitive tool logic in browser JavaScript
- Short-lived access token kept in sessionStorage
- Refresh token uses an httpOnly cookie
- All protected actions route through the backend

## What did not stay the same
The original browser-side signing and wallet-generation flows were not preserved. Those are exactly the things that make the current frontend too exposed.

Use one of these patterns instead:
1. browser wallet / extension signs user actions locally, or
2. a private worker handles protected execution on the server side.
