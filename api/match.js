const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SLA_MINUTES = 15;
const BATCH_SIZE = 50;

async function runMatcher() {
  const { data: incoming, error } = await supabase
    .from("tracked_emails")
    .select("*")
    .eq("is_incoming", true)
    .eq("has_response", false)
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    throw error;
  }

  let matched = 0;

  for (const email of incoming) {
    const { data: reply } = await supabase
      .from("tracked_emails")
      .select("*")
      .eq("is_incoming", false)
      .eq("conversation_id", email.conversation_id)
      .gte("received_at", email.received_at)
      .order("received_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!reply) {
      continue;
    }

    const responseMinutes = Math.round(
      (new Date(reply.received_at) - new Date(email.received_at)) / 60000
    );

    await supabase
      .from("tracked_emails")
      .update({
        has_response: true,
        first_response_at: reply.received_at,
        first_responder_email: reply.employee_email,
        response_time_minutes: responseMinutes,
        sla_breached: responseMinutes > SLA_MINUTES
      })
      .eq("id", email.id);

    matched++;
  }

  return matched;
}

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const matched = await runMatcher();
    res.status(200).json({ ok: true, matched });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Matcher failed" });
  }
};
