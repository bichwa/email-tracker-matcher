const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SLA_TARGET_MINUTES = parseInt(
  process.env.SLA_TARGET_MINUTES || "15",
  10
);

const BATCH_SIZE = 25;
const MAX_RUNTIME_MS = 50000;

async function runMatcher() {
  const start = Date.now();
  let matched = 0;

  const { data: incomingEmails, error } = await supabase
    .from("tracked_emails")
    .select("*")
    .eq("is_incoming", true)
    .eq("has_response", false)
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    throw error;
  }

  for (const incoming of incomingEmails) {
    if (Date.now() - start > MAX_RUNTIME_MS) {
      console.log("Stopping early to avoid timeout");
      break;
    }

    let response = null;

    const isTeamMailbox =
      incoming.employee_email &&
      incoming.employee_email.toLowerCase().startsWith("team@");

    if (incoming.conversation_id) {
      let query = supabase
        .from("tracked_emails")
        .select("*")
        .eq("conversation_id", incoming.conversation_id)
        .eq("is_incoming", false)
        .gte("received_at", incoming.received_at)
        .order("received_at", { ascending: true })
        .limit(1);

      if (!isTeamMailbox) {
        query = query.eq(
          "employee_email",
          incoming.employee_email
        );
      }

      const { data } = await query;
      if (data && data.length) {
        response = data[0];
      }
    }

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
      if (data && data.length) {
        response = data[0];
      }
    }

    if (!response) {
      continue;
    }

    const responseMinutes = Math.round(
      (new Date(response.received_at) -
        new Date(incoming.received_at)) / 60000
    );

    const slaBreached =
      responseMinutes > SLA_TARGET_MINUTES;

    await supabase
      .from("tracked_emails")
      .update({
        has_response: true,
        responded_at: response.received_at,
        responded_by: response.responded_by,
        response_time_minutes: responseMinutes,
        first_response_at:
          incoming.first_response_at ??
          response.received_at,
        first_responder_email:
          incoming.first_responder_email ??
          response.responded_by,
        sla_breached: slaBreached
      })
      .eq("id", incoming.id);

    matched++;
  }

  console.log("Matcher batch complete", {
    matched,
    processed: incomingEmails.length
  });
}

module.exports = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (
      authHeader !==
      `Bearer ${process.env.CRON_SECRET}`
    ) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    res.status(200).json({
      ok: true,
      batch: true
    });

    runMatcher().catch(err => {
      console.error("Matcher error", err);
    });
  } catch (err) {
    console.error("Handler error", err);
    res.status(500).json({
      error: "Internal error"
    });
  }
};
