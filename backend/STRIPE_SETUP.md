# Stripe Setup Guide

## Step 1 — Create Stripe account

1. Go to https://dashboard.stripe.com/register
2. Complete account setup
3. No business verification needed for test mode — you can start testing immediately

## Step 2 — Get API keys

1. Dashboard → Developers → API Keys
2. Copy the **Secret key** (`sk_test_...`) → set as `STRIPE_SECRET_KEY` in `.env`
3. Never use the publishable key on the backend — it belongs in frontend code only

## Step 3 — Set up webhook for local development

1. Install the Stripe CLI: https://stripe.com/docs/stripe-cli
2. Authenticate:
   ```
   stripe login
   ```
3. Forward events to your local server:
   ```
   stripe listen --forward-to localhost:3001/api/stripe/webhook
   ```
4. Copy the **webhook signing secret** (`whsec_...`) printed by the CLI → set as `STRIPE_WEBHOOK_SECRET` in `.env`
5. Keep this terminal running while developing — it must be active during checkout testing

## Step 4 — Set up webhook for production

1. Dashboard → Developers → Webhooks → **Add endpoint**
2. URL: `https://yourdomain.com/api/stripe/webhook`
3. Events to listen for: `checkout.session.completed`
4. After saving, reveal the **Signing secret** → set as `STRIPE_WEBHOOK_SECRET` in your production environment

## Step 5 — Test the flow

1. Start the Stripe CLI listener (Step 3)
2. Open the app and click **Buy Credits**
3. Use test card: `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP
4. Complete the checkout — you should be redirected to `/credits/success`
5. Verify the `credit_txns` table has a new row with `reason = 'purchase'`
6. Verify the `credits` table shows the updated balance

## Credit packages

| Package | Credits | Price  | Per analysis |
|---------|---------|--------|--------------|
| Starter | 5       | $2.50  | $0.50        |
| Pro     | 15      | $6.00  | $0.40        |
| Power   | 40      | $14.00 | $0.35        |
