const { createClient } = require("@supabase/supabase-js");

/* ------------------------------------------------------------------ */
/*  Init                                                              */
/* ------------------------------------------------------------------ */

let supabase;

function initClients() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return { supabase };
}

/* ------------------------------------------------------------------ */
/*  Match responses + FIRST RESPONDER LOCK                             */
/* ------------------------------------------------------------------ */

async function matchResponses() {
  const { supabase } = initClients();
  const SLA_MINUTES = parseInt(process.env.SLA_TARGET_MINUTES || "15");

  const { data: incoming } = await supabase
    .from("tracked_emails")
    .select("*")
    .eq("is_incoming", true)
    .eq("has_response", false)
    .order("received_at", { ascending: true });

  if (!incoming?.length) return { checked: 0, matched: 0 };

  let matched = 0;

  for (const email of incoming) {
    let response = null;

    // 1️⃣ Match by conversation
    if (email.conversation_id) {
      const { data } = await supabase
        .from("tracked_emails")
        .select("*")
        .eq("conversation_id", email.conversation_id)
        .eq("is_incoming", false)
        .gte("received_at", email.received_at)
        .order("received_at", { ascending: true })
        .limit(1);

      if (data?.length) response = data[0];
    }

    // 2️⃣ Fallback: same client within 24h
    if (!response) {
      const end = new Date(
        new Date(email.received_at).getTime() + 86400000
      ).toISOString();

      const { data } = await supabase
        .from("tracked_emails")
        .select("*")
        .eq("is_incoming", false)
        .eq("client_email", email.client_email)
        .gte("received_at", email.received_at)
        .lte("received_at", end)
        .order("received_at", { ascending: true })
        .limit(1);

      if (data?.length) response = data[0];
    }

    if (!response) continue;

    const responseMinutes = Math.round(
      (new Date(response.received_at) - new Date(email.received_at)) / 60000
    );

    const slaBreached = responseMinutes > SLA_MINUTES;

    await supabase
      .from("tracked_emails")
      .update({
        has_response: true,
        responded_at: response.received_at,
        responded_by: response.responded_by,
        response_time_minutes: responseMinutes,

        // 🔒 FIRST RESPONDER (write once)
        first_response_at: email.first_response_at ?? response.received_at,
        first_responder_email:
          email.first_responder_email ?? response.responded_by,

        sla_breached: slaBreached
      })
      .eq("id", email.id);

    matched++;
  }

  return { checked: incoming.length, matched };
}

/* ------------------------------------------------------------------ */
/*  Aggregate DAILY metrics by FIRST RESPONDER                         */
/* ------------------------------------------------------------------ */

async function calculateDailyFirstResponderMetrics() {
  const { supabase } = initClients();

  const { data: rows } = await supabase
    .from("tracked_emails")
    .select(
      `
      first_responder_email,
      first_response_at,
      response_time_minutes,
      sla_breached
    `
    )
    .not("first_response_at", "is", null);

  if (!rows?.length) return;

  const grouped = {};

  for (const r of rows) {
    const date = r.first_response_at.split("T")[0];
    const key = `${date}|${r.first_responder_email}`;

    if (!grouped[key]) {
      grouped[key] = {
        date,
        email: r.first_responder_email,
        count: 0,
        totalMinutes: 0,
        breaches: 0
      };
    }

    grouped[key].count++;
    grouped[key].totalMinutes += r.response_time_minutes || 0;
    if (r.sla_breached) grouped[key].breaches++;
  }

  for (const k of Object.keys(grouped)) {
    const g = grouped[k];
    const avg =
      g.count > 0
        ? Number((g.totalMinutes / g.count).toFixed(2))
        : null;

    await supabase
      .from("daily_first_responder_metrics")
      .upsert(
        {
          date: g.date,
          first_responder_email: g.email,
          total_first_responses: g.count,
          avg_first_response_minutes: avg,
          sla_breaches: g.breaches
        },
        { onConflict: "date,first_responder_email" }
      );
  }
}

/* ------------------------------------------------------------------ */
/*  Handler                                                           */
/* ------------------------------------------------------------------ */

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();

  const matchResult = await matchResponses();
  await calculateDailyFirstResponderMetrics();

  res.json({
    success: true,
    ...matchResult,
    duration_seconds: ((Date.now() - start) / 1000).toFixed(2)
  });
};
