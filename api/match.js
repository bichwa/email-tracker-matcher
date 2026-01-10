const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SLA_TARGET_MINUTES = 15;
const BATCH_SIZE = 30;
const MAX_RUNTIME_MS = 50000;

function detectScenario(email) {
  if (email.is_system_email) return "SYSTEM_EXCLUDED";
  if (email.is_solver_email) return "SOLVER_EXCLUDED";

  if (email.employee_email?.toLowerCase().startsWith("team@")) {
    if (email.tagged_employee_email) {
      return "TEAM_TAGGED_PERSON";
    }
    return "TEAM_UNTAGGED";
  }

  return "DIRECT_PERSONAL";
}

async function runMatcher() {
  const start = Date.now();
  let processed = 0;
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
      break;
    }

    const scenario = detectScenario(incoming);

    if (
      scenario === "SYSTEM_EXCLUDED" ||
      scenario === "SOLVER_EXCLUDED"
    ) {
      await supabase
        .from("tracked_emails")
        .update({
          has_response: true,
          scenario,
          sla_exempt: true
        })
        .eq("id", incoming.id);

      processed++;
      continue;
    }

    let response = null;

    if (incoming.conversation_id) {
      let convoQuery = supabase
        .from("tracked_emails")
        .select("*")
        .eq("conversation_id", incoming.conversation_id)
        .eq("is_incoming", false)
        .gte("received_at", incoming.received_at)
        .order("received_at", { ascending: true })
        .limit(1);

      if (scenario === "DIRECT_PERSONAL") {
        convoQuery = convoQuery.eq(
          "employee_email",
          incoming.employee_email
        );
      }

      const { data } = await convoQuery;
      if (data?.length) {
        response = data[0];
      }
    }

    if (!response) {
      const endWindow = new Date(
        new Date(incoming.received_at).getTime() +
          24 * 60 * 60 * 1000
      ).toISOString();

      let fallbackQuery = supabase
        .from("tracked_emails")
        .select("*")
        .eq("client_email", incoming.client_email)
        .eq("is_incoming", false)
        .gte("received_at", incoming.received_at)
        .lte("received_at", endWindow)
        .order("received_at", { ascending: true })
        .limit(1);

      if (scenario === "DIRECT_PERSONAL") {
        fallbackQuery = fallbackQuery.eq(
          "employee_email",
          incoming.employee_email
        );
      }

      const { data } = await fallbackQuery;
      if (data?.length) {
        response = data[0];
      }
    }

    if (!response) {
      processed++;
      continue;
    }

    const responseMinutes = Math.round(
      (new Date(response.received_at) -
        new Date(incoming.received_at)) / 60000
    );

    const slaBreached = responseMinutes > SLA_TARGET_MINUTES;

    await supabase
      .from("tracked_emails")
      .update({
        has_response: true,
        responded_at: response.received_at,
        first_response_at:
          incoming.first_response_at || response.received_at,
        responder_email:
          incoming.responder_email || response.employee_email,
        response_time_minutes: responseMinutes,
        sla_breached: slaBreached,
        sla_target_minutes: SLA_TARGET_MINUTES,
        scenario
      })
      .eq("id", incoming.id);

    matched++;
    processed++;
  }

  console.log("Matcher completed", {
    processed,
    matched
  });
}

module.exports = async (req, res) => {
  try {
    if (
      req.headers.authorization !==
      `Bearer ${process.env.CRON_SECRET}`
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    res.status(200).json({ ok: true });

    runMatcher().catch(err => {
      console.error("Matcher runtime error", err);
    });
  } catch (err) {
    console.error("Matcher handler error", err);
    res.status(500).json({ error: "Internal error" });
  }
};
