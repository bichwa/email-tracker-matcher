// email-tracker-matcher/api/match.js
// Matches incoming emails to first responses
// Supports TEAM mailbox attribution (Step 4F)

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SLA_TARGET_MINUTES = parseInt(
  process.env.SLA_TARGET_MINUTES || "15",
  10
);

module.exports = async (req, res) => {
  try {
    /* ------------------ AUTH ------------------ */
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const start = Date.now();

    /* ------------------ FETCH UNRESPONDED INCOMING ------------------ */
    const { data: incomingEmails, error } = await supabase
      .from("tracked_emails")
      .select("*")
      .eq("is_incoming", true)
      .eq("has_response", false)
      .order("received_at", { ascending: true });

    if (error) throw error;

    let matched = 0;

    /* ------------------ MATCH LOOP ------------------ */
    for (const incoming of incomingEmails) {
      let response = null;

      const isTeamMailbox =
        incoming.employee_email &&
        incoming.employee_email.toLowerCase().startsWith("team@");

      /* ---------- STRATEGY 1: CONVERSATION ID ---------- */
      if (incoming.conversation_id) {
        let query = supabase
          .from("tracked_emails")
          .select("*")
          .eq("conversation_id", incoming.conversation_id)
          .eq("is_incoming", false)
          .gte("received_at", incoming.received_at)
          .order("received_at", { ascending: true })
          .limit(1);

        // 🔑 Team mailbox logic:
        // Do NOT restrict responder mailbox for team@
        if (!isTeamMailbox) {
          query = query.eq(
            "employee_email",
            incoming.employee_email
          );
        }

        const { data } = await query;
        if (data?.length) response = data[0];
      }

      /* ---------- STRATEGY 2: SAME CLIENT (24h) ---------- */
      if (!response) {
        const endWindow = new Date(
          new Date(incoming.received_at).getTime() +
            24 * 60 * 60 * 1000
        ).toISOString();

        let query = supabase
          .from("tracked_emails")
          .select("*")
          .eq("client_email", incoming.client_email)
          .eq("is_incoming", false)
          .gte("received_at", incoming.received_at)
          .lte("received_at", endWindow)
          .order("received_at", { ascending: true })
          .limit(1);

        if (!isTeamMailbox) {
          query = query.eq(
            "employee_email",
            incoming.employee_email
          );
        }

        const { data } = await query;
        if (data?.length) response = data[0];
      }

      if (!response) continue;

      /* ------------------ RESPONSE METRICS ------------------ */
      const responseMinutes = Math.round(
        (new Date(response.received_at) -
          new Date(incoming.received_at)) /
          60000
      );

      const slaBreached = responseMinutes > SLA_TARGET_MINUTES;

      /* ------------------ UPDATE INCOMING EMAIL ------------------ */
      await supabase
        .from("tracked_emails")
        .update({
          has_response: true,
          responded_at: response.received_at,
          responded_by: response.responded_by,
          response_time_minutes: responseMinutes,

          // 🔒 FIRST RESPONDER (LOCK ONCE)
          first_response_at:
            incoming.first_response_at ?? response.received_at,
          first_responder_email:
            incoming.first_responder_email ??
            response.responded_by,

          sla_breached: slaBreached
        })
        .eq("id", incoming.id);

      matched++;
    }

    /* ------------------ DONE ------------------ */
    res.json({
      success: true,
      matched,
      duration_seconds: (
        (Date.now() - start) /
        1000
      ).toFixed(2)
    });
  } catch (err) {
    console.error("Matcher error:", err);
    res.status(500).json({ error: err.message });
  }
};
