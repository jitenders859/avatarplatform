import Stripe from "stripe";
import { env } from "@/lib/env";

let _stripe: Stripe | null = null;

/** Lazily-constructed singleton so builds/tests don't require STRIPE_SECRET_KEY to be set. */
export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(env.stripeSecretKey, {
      apiVersion: "2025-02-24.acacia",
    });
  }
  return _stripe;
}
