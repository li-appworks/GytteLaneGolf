// Receives Stripe's webhooks and keeps event_payments/refunds in step:
//   checkout.session.completed -> marks the event_payments row paid
//                                 ('in_app'), with Stripe's actual fee
//   charge.refunded            -> records each refund and the refunded total
// Refunds are issued in the Stripe dashboard; this is what makes them show
// up against the player in the app without anyone re-entering them.
//
// Deployed with verify_jwt turned OFF — Stripe calls this directly with
// no Supabase auth at all, so the normal JWT check would reject every
// request before our own signature verification even runs. The real
// authentication here is the Stripe signature check below.
//
// Anything that isn't ours (unknown event types, sessions/charges with no
// matching payment) is acknowledged with 200 and ignored — a non-2xx makes
// Stripe retry it for days.

import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const ok = () =>
  new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });

const today = () => new Date().toISOString().slice(0, 10);
const dateOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id ?? null);

// What Stripe actually charged for this payment (varies by card type), from
// the charge's balance transaction. Null if it isn't available yet — the
// payment is still recorded; only the fee line in Accounts misses it.
async function actualFee(paymentIntentId: string): Promise<number | null> {
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge.balance_transaction"],
    });
    const charge = pi.latest_charge as Stripe.Charge | null;
    const bt = charge?.balance_transaction as Stripe.BalanceTransaction | null;
    return bt && typeof bt === "object" ? bt.fee / 100 : null;
  } catch (err) {
    console.error("Could not look up Stripe fee:", err);
    return null;
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<Response> {
  const { event_id, player_id, society_id } = session.metadata ?? {};
  if (!event_id || !player_id || !society_id) {
    console.warn("Ignoring checkout session without our metadata:", session.id);
    return ok();
  }
  if (session.payment_status !== "paid") {
    console.warn("Ignoring checkout session that isn't paid:", session.id, session.payment_status);
    return ok();
  }

  const paymentIntent = idOf(session.payment_intent);

  // A fresh payment clears any earlier cancellation/refund state on the row
  // (the refunds table keeps that history).
  const { error } = await supabase.from("event_payments").upsert(
    {
      event_id,
      player_id: Number(player_id),
      society_id,
      amount: (session.amount_total ?? 0) / 100,
      paid: true,
      paid_date: today(),
      payment_method: "in_app",
      stripe_session_id: session.id,
      stripe_payment_intent: paymentIntent,
      stripe_fee: paymentIntent ? await actualFee(paymentIntent) : null,
      cancelled_at: null,
      refunded_amount: 0,
      refunded_date: null,
    },
    { onConflict: "event_id,player_id" },
  );
  if (error) {
    console.error("Could not record Stripe payment:", error);
    return new Response("Database error", { status: 500 });
  }
  return ok();
}

async function handleChargeRefunded(charge: Stripe.Charge): Promise<Response> {
  const paymentIntent = idOf(charge.payment_intent);
  if (!paymentIntent) return ok();

  const { data: payment } = await supabase
    .from("event_payments")
    .select("id, event_id, player_id, society_id")
    .eq("stripe_payment_intent", paymentIntent)
    .maybeSingle();
  if (!payment) {
    console.warn("Refund for a payment we don't track:", paymentIntent);
    return ok();
  }

  // The webhook payload doesn't reliably include the refund list, so fetch
  // it. Upserting by stripe_refund_id makes redelivered webhooks harmless.
  const refunds = await stripe.refunds.list({ charge: charge.id, limit: 100 });
  const rows = refunds.data
    .filter((r) => r.status === "succeeded")
    .map((r) => ({
      society_id: payment.society_id,
      event_id: payment.event_id,
      player_id: payment.player_id,
      amount: r.amount / 100,
      refunded_date: dateOf(r.created),
      method: "in_app",
      stripe_refund_id: r.id,
    }));
  if (rows.length) {
    const { error } = await supabase.from("refunds").upsert(rows, { onConflict: "stripe_refund_id", ignoreDuplicates: true });
    if (error) {
      console.error("Could not record refunds:", error);
      return new Response("Database error", { status: 500 });
    }
  }

  const { error } = await supabase
    .from("event_payments")
    .update({ refunded_amount: charge.amount_refunded / 100, refunded_date: today() })
    .eq("id", payment.id);
  if (error) {
    console.error("Could not update refunded amount:", error);
    return new Response("Database error", { status: 500 });
  }
  return ok();
}

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      return await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    }
    if (event.type === "charge.refunded") {
      return await handleChargeRefunded(event.data.object as Stripe.Charge);
    }
    return ok();
  } catch (err) {
    console.error("Webhook handling error:", err);
    return new Response("Handler error", { status: 500 });
  }
});
