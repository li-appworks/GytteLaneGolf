// Creates a Stripe Checkout Session for a single event fee.
//
// Deliberately never trusts a client-supplied amount: the price always
// comes from the event's own `cost` field (or an existing event_payments
// row's amount, if an admin already set a custom one for this player),
// looked up server-side with the service role key. The client only ever
// supplies event_id + player_id (+ origin, which is checked against the
// society's own domain before use).
//
// Only societies with societies.stripe_enabled (set by a platform admin)
// can take card payments — there's one Stripe account behind this, so
// any other society's payments would land in the wrong club's account.
//
// Deployed with verify_jwt left on (the default) — the browser calls this
// with the normal Supabase anon key, same as every other client request.

import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseFee(cost: string | null): number {
  if (!cost) return 0;
  const n = parseFloat(cost.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Where to send the player back to after Checkout. Only the society's own
// custom domain (or its www. form) is accepted from the client; anything
// else falls back to the custom domain, so this can't be used to bounce
// people to an arbitrary site after they've paid.
function returnOrigin(clientOrigin: string | undefined, customDomain: string | null): string | null {
  const domain = (customDomain || "").toLowerCase();
  if (!domain) return null;
  try {
    const u = new URL(clientOrigin || "");
    const host = u.hostname.toLowerCase();
    if (u.protocol === "https:" && (host === domain || host === `www.${domain}`)) return u.origin;
  } catch {
    // fall through to the society's own domain
  }
  return `https://${domain}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { event_id, player_id, origin } = await req.json();
    if (!event_id || !player_id) {
      return json({ error: "event_id and player_id are required" }, 400);
    }

    const { data: event, error: eventErr } = await supabase
      .from("events")
      .select("id, name, cost, society_id")
      .eq("id", event_id)
      .single();
    if (eventErr || !event) return json({ error: "Event not found" }, 404);

    const { data: society } = await supabase
      .from("societies")
      .select("id, stripe_enabled, custom_domain")
      .eq("id", event.society_id)
      .single();
    if (!society?.stripe_enabled) {
      return json({ error: "Card payments aren't available for this society — please pay by bank transfer." }, 403);
    }

    const { data: player, error: playerErr } = await supabase
      .from("players")
      .select("id, first_name, last_name, society_id")
      .eq("id", player_id)
      .single();
    if (playerErr || !player || player.society_id !== event.society_id) {
      return json({ error: "Player not found" }, 404);
    }

    // A custom per-player amount (set by an admin) takes priority over the
    // event's default cost, same rule the existing manual payment UI uses.
    const { data: existingPayment } = await supabase
      .from("event_payments")
      .select("amount, paid, refunded_amount")
      .eq("event_id", event_id)
      .eq("player_id", player_id)
      .maybeSingle();

    // Paid and not fully refunded = genuinely paid. A fully refunded payment
    // (cancelled, then signed up again) can be paid afresh.
    const refunded = Number(existingPayment?.refunded_amount || 0);
    if (existingPayment?.paid && refunded < Number(existingPayment.amount)) {
      return json({ error: "This is already marked as paid." }, 400);
    }

    const fee = existingPayment ? Number(existingPayment.amount) : parseFee(event.cost);
    if (!(fee > 0)) return json({ error: "This event has no payable amount set." }, 400);

    const back = returnOrigin(origin, society.custom_domain);
    if (!back) return json({ error: "This society has no website domain set up for card payments." }, 400);

    const metadata = {
      event_id: String(event.id),
      player_id: String(player.id),
      society_id: event.society_id,
    };

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: { name: `${event.name} — ${player.first_name} ${player.last_name}` },
            unit_amount: Math.round(fee * 100),
          },
          quantity: 1,
        },
      ],
      metadata,
      // Copied onto the PaymentIntent too, so a payment (or a refund of it)
      // viewed in the Stripe dashboard says which event and player it was for.
      payment_intent_data: { metadata },
      success_url: `${back}/?stripe=success#events`,
      cancel_url: `${back}/?stripe=cancelled#events`,
    });

    return json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return json({ error: "Could not start checkout." }, 500);
  }
});
