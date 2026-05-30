# Stripe Production Setup

## Step 1 — Activate Live Mode

1. Go to [dashboard.stripe.com](https://dashboard.stripe.com)
2. Toggle the switch in the top-left from **Test mode** to **Live mode**
3. Complete account activation (business details, bank account) if prompted
4. Your **live secret key** is now at Developers → API keys (`sk_live_...`)

---

## Step 2 — Create Products

Create one product per tier. Live mode products are separate from test mode ones.

1. Go to **Products → Add product**
2. Create three products:

| Name    | Description                  |
|---------|------------------------------|
| Starter | 5 resume analysis credits    |
| Pro     | 15 resume analysis credits   |
| Power   | 40 resume analysis credits   |

- Type: **One-time** (not recurring)
- Do **not** add a price yet — you'll do that in the next step

---

## Step 3 — Create Prices (USD + INR)

For each product, add **two prices** — one in USD, one in INR.

### Naming convention
Use the product description field or metadata to keep track. Price IDs look like `price_1AbCdEfGhIjKlMnO`.

### Starter — 5 credits
| Currency | Amount | Price ID var              |
|----------|--------|---------------------------|
| USD      | $2.50  | `STRIPE_PRICE_USD_STARTER` |
| INR      | ₹99   | `STRIPE_PRICE_INR_STARTER` |

### Pro — 15 credits
| Currency | Amount | Price ID var           |
|----------|--------|------------------------|
| USD      | $6.00  | `STRIPE_PRICE_USD_PRO` |
| INR      | ₹199   | `STRIPE_PRICE_INR_PRO` |

### Power — 40 credits
| Currency | Amount  | Price ID var             |
|----------|---------|--------------------------|
| USD      | $14.00  | `STRIPE_PRICE_USD_POWER` |
| INR      | ₹299  | `STRIPE_PRICE_INR_POWER` |

**How to create a price:**
1. Open a product → click **Add another price**
2. Set currency, amount, type = **One time**
3. Click **Save** and copy the `price_...` ID immediately

---

## Step 4 — Copy Price IDs into Environment

Paste the 6 live price IDs into your production `.env`:

```
STRIPE_PRICE_USD_STARTER=price_live_...
STRIPE_PRICE_USD_PRO=price_live_...
STRIPE_PRICE_USD_POWER=price_live_...
STRIPE_PRICE_INR_STARTER=price_live_...
STRIPE_PRICE_INR_PRO=price_live_...
STRIPE_PRICE_INR_POWER=price_live_...
```

---

## Step 5 — Set Live Secret Key

```
STRIPE_SECRET_KEY=sk_live_...
```

Never commit this. Set it as an environment variable in your hosting platform (Render / Railway / Fly.io).

---

## Step 6 — Configure Webhook Endpoint

1. Go to **Developers → Webhooks → Add endpoint**
2. Endpoint URL: `https://yourdomain.com/api/stripe/webhook`
3. Events to listen for:
   - `checkout.session.completed`
4. Click **Add endpoint**
5. Copy the **Signing secret** (`whsec_live_...`) into:
   ```
   STRIPE_WEBHOOK_SECRET=whsec_live_...
   ```

> Your server must receive the **raw request body** for webhook signature verification to work.
> The `express.raw({ type: 'application/json' })` middleware must be registered **before** `express.json()` on the webhook route.

---

## Step 7 — Verify Payments End-to-End

1. Use a **real card** (your own) for the first test — Stripe charges it and you can immediately refund
2. Or use Stripe's **test cards in live mode** — not available; live mode requires real cards
3. Check the Stripe Dashboard → Payments for the transaction
4. Verify credits were added to the user in your database
5. Check webhook logs: Developers → Webhooks → your endpoint → Recent deliveries

---

## Step 8 — Common Mistakes to Avoid

| Mistake | Fix |
|--------|-----|
| Using test price IDs in live mode | Re-create all prices in live mode; IDs are mode-specific |
| Using `sk_test_` key with live webhook secret | Both keys must match the mode |
| Webhook body already parsed | Register webhook route before `express.json()` |
| Missing idempotency on webhook | Check `stripe_events` table deduplication before crediting |
| INR price below Stripe minimum | ₹50 minimum; ₹199 is safe |
| Not verifying webhook signature | Always call `stripe.webhooks.constructEvent()` |
| Hardcoding price IDs in source code | Always use environment variables |
