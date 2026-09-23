// Sends a new (or newly-emailed) player a branded welcome email via Resend,
// inviting them to set up their account on the society's site.
//
// Called from the browser right after an admin saves a player with an email.
// Deployed with verify_jwt on; the caller must also be an admin of that
// player's society (checked with their own JWT against is_admin()), so it
// can't be used to email arbitrary players or addresses. The recipient is
// always the address stored on the player row, never one from the request.
//
// Secrets: RESEND_API_KEY (a Resend key with sending access).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const FROM_ADDRESS = "noreply@gyttelanegolf.co.uk"; // the domain verified in Resend

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

function esc(s: unknown) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const hexOr = (v: string | null | undefined, fallback: string) =>
  v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;

function emailHtml(opts: { firstName: string; society: string; location: string | null; signInUrl: string; siteUrl: string; primary: string; accent: string; contact: string | null }) {
  const { firstName, society, location, signInUrl, siteUrl, primary, accent, contact } = opts;
  return `<!DOCTYPE html>
<html><body style="margin:0; padding:0; background:#ECEBE1; font-family:Arial,Helvetica,sans-serif; color:#26241F;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ECEBE1; padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background:#FAF8F2; border-radius:8px; overflow:hidden;">
        <tr><td style="background:${primary}; padding:22px 28px;">
          <div style="color:#FAF8F2; font-size:20px; font-weight:bold;">${esc(society)}</div>
          ${location ? `<div style="color:${accent}; font-size:12px; letter-spacing:1px; text-transform:uppercase; margin-top:4px;">${esc(location)}</div>` : ""}
        </td></tr>
        <tr><td style="height:3px; background:${accent}; line-height:3px; font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px;">
          <p style="font-size:18px; font-weight:bold; margin:0 0 14px; color:${primary};">Welcome, ${esc(firstName)}!</p>
          <p style="font-size:15px; line-height:1.6; margin:0 0 14px;">You've been added as a member of ${esc(society)} on our website. Set up your account to:</p>
          <ul style="font-size:15px; line-height:1.7; margin:0 0 20px; padding-left:20px;">
            <li>see upcoming events and sign up</li>
            <li>follow live scores and results on the day</li>
            <li>keep track of your payments and scores in My Account</li>
          </ul>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="background:${accent}; border-radius:6px;">
            <a href="${signInUrl}" style="display:inline-block; padding:12px 22px; color:#1f1a14; font-size:15px; font-weight:bold; text-decoration:none;">Set up my account</a>
          </td></tr></table>
          <p style="font-size:14px; line-height:1.6; margin:0 0 8px; color:#5B5A52;">On the sign-in page, choose <strong>First time?</strong> and enter this email address — we'll send you a link to finish setting up.</p>
          <p style="font-size:14px; line-height:1.6; margin:0; color:#5B5A52;">Or just visit <a href="${siteUrl}" style="color:${primary};">${esc(siteUrl.replace(/^https:\/\//, ""))}</a>.</p>
        </td></tr>
        <tr><td style="padding:16px 28px; border-top:1px solid #D8D5C6; font-size:12px; color:#5B5A52;">
          You're receiving this because the ${esc(society)} committee added you as a member.${contact ? ` Questions? Reply to this email or contact <a href="mailto:${esc(contact)}" style="color:${primary};">${esc(contact)}</a>.` : ""}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { player_id } = await req.json();
    if (!player_id) return json({ error: "player_id is required" }, 400);

    const { data: player } = await admin
      .from("players")
      .select("id, first_name, email, active, society_id")
      .eq("id", player_id)
      .single();
    if (!player) return json({ error: "Player not found" }, 404);
    if (!player.email) return json({ error: "This player has no email address." }, 400);
    if (player.active === false) return json({ error: "This player is inactive." }, 400);

    // The caller must be an admin of this player's society.
    const caller = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: isAdmin } = await caller.rpc("is_admin", { target_society_id: player.society_id });
    if (isAdmin !== true) return json({ error: "Only an admin of this society can send welcome emails." }, 403);

    const { data: soc } = await admin
      .from("societies")
      .select("name, location, custom_domain, contact_email, primary_colour, secondary_colour")
      .eq("id", player.society_id)
      .single();
    if (!soc?.custom_domain) return json({ error: "This society has no website domain set up." }, 400);

    const siteUrl = `https://${soc.custom_domain}`;
    const html = emailHtml({
      firstName: player.first_name,
      society: soc.name,
      location: soc.location,
      signInUrl: `${siteUrl}/login.html`,
      siteUrl,
      primary: hexOr(soc.primary_colour, "#4B1320"),
      accent: hexOr(soc.secondary_colour, "#B8862F"),
      contact: soc.contact_email,
    });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${soc.name} <${FROM_ADDRESS}>`,
        to: [player.email],
        reply_to: soc.contact_email || undefined,
        subject: `Welcome to ${soc.name}`,
        html,
      }),
    });
    if (!res.ok) {
      console.error("Resend error:", res.status, await res.text());
      return json({ error: "The email service didn't accept the message." }, 502);
    }

    await admin.from("players").update({ welcome_sent_at: new Date().toISOString() }).eq("id", player.id);
    return json({ sent: true });
  } catch (err) {
    console.error("send-welcome-email error:", err);
    return json({ error: "Could not send the welcome email." }, 500);
  }
});
