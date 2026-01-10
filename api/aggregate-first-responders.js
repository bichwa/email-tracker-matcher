import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SLA_MINUTES = 15;

export default async function handler(req, res) {
  try {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const { data: emails, error } = await supabase
      .from("tracked_emails")
      .select(
        `
        employee_email,
        received_at,
        first_response_at
        `
      )
      .gte("received_at", `${date}T00:00:00Z`)
      .lte("received_at", `${date}T23:59:59Z`)
      .not("first_response_at", "is", null);

    if (error) {
      throw error;
    }

    if (!emails || emails.length === 0) {
      return res.json({
        success: true,
        date,
        inserted: 0,
        note: "No first-responder emails for this date"
      });
    }

    const grouped = {};

    for (const e of emails) {
      const mins =
        (new Date(e.first_response_at) -
          new Date(e.received_at)) /
        60000;

      if (!grouped[e.employee_email]) {
        grouped[e.employee_email] = {
          employee_email: e.employee_email,
          total_first_responses: 0,
          total_minutes: 0,
          sla_breaches: 0
        };
      }

      grouped[e.employee_email].total_first_responses += 1;
      grouped[e.employee_email].total_minutes += mins;

      if (mins > SLA_MINUTES) {
        grouped[e.employee_email].sla_breaches += 1;
      }
    }

    const rows = Object.values(grouped).map(r => ({
      date,
      employee_email: r.employee_email,
      total_first_responses: r.total_first_responses,
      avg_first_response_minutes: Math.round(
        r.total_minutes / r.total_first_responses
      ),
      sla_breaches: r.sla_breaches,
      sla_target_minutes: SLA_MINUTES
    }));

    const { error: upsertError } = await supabase
      .from("daily_first_responder_metrics")
      .upsert(rows, {
        onConflict: "date,employee_email"
      });

    if (upsertError) {
      throw upsertError;
    }

    return res.json({
      success: true,
      date,
      inserted: rows.length
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "FUNCTION_INVOCATION_FAILED",
      message: err.message
    });
  }
}
