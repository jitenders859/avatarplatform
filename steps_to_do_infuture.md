Sounds good. Here's exactly what to do in the Stripe dashboard (make sure you're in Live mode, top-right toggle):

1. Create the 3 prices
Go to Product catalog → + Add product, and create three recurring products:

Starter — $19.00/month
Pro — $59.00/month
Business — $199.00/month
For each, after saving, click into the price and copy the ID starting with price_... (not the product ID, which starts with prod_).

2. Create the webhook endpoint
Go to Developers → Webhooks → + Add endpoint:

Endpoint URL: https://<your-production-domain>/api/billing/webhook
Events to send: checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted
After creating it, click "Reveal" on the Signing secret (starts with whsec_...) and copy it.

3. Send me the 4 values (or paste them straight into .env yourself) and I'll wire them in:


STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_BUSINESS=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
Once those are set and the server restarts, the Upgrade buttons and checkout flow should work end-to-end.