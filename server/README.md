# CryptoPixels Server (minimal)

This small server provides secure checkout and verification endpoints that the client calls.

Environment variables required:

- `SUPABASE_URL` - your Supabase project URL
- `SUPABASE_SERVICE_KEY` - Supabase service_role key (keep secret)
- `SUPABASE_ANON_KEY` - Supabase anon key for client-side reads when used
- `PAYMENT_RECEIVER` - checksum ETH address that will receive funds
- `PRICE_PER_PIXEL_ETH` - price per pixel in ETH (default: `0.0001`)
- `RESERVATION_TTL_MINUTES` - checkout reservation timeout (default: `15`)
- `BASE_RPC_URL` - optional (defaults to https://mainnet.base.org)

A `.env.example` file is provided for local setup; do not commit your `.env` file.

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
