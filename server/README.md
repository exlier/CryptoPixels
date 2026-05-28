# CryptoPixels Server (minimal)

This small server provides secure checkout and verification endpoints that the client calls.

Environment variables required:

- `SUPABASE_URL` - your Supabase project URL
- `SUPABASE_SERVICE_KEY` - Supabase service_role key (keep secret)
- `PAYMENT_RECEIVER` - checksum ETH address that will receive funds
- `BASE_RPC_URL` - optional (defaults to https://mainnet.base.org)

Install and run:

```bash
cd server
npm install
npm start
```

The server exposes:
- `GET /api/pixels` - list all pixels
- `GET /api/pixel?x=..&y=..` - single pixel
- `POST /api/checkout` - reserve pixels and receive `priceWei`, `paymentReceiver`, and `reserveToken`
- `POST /api/verify` - send `{ txHash, reserveToken }` to finalize claim after the on-chain payment

Security notes:
- Do NOT commit your `SUPABASE_SERVICE_KEY` or `PAYMENT_RECEIVER` into Git.
- The server performs DNS checks to reduce SSRF risk and fetches image metadata safely.
