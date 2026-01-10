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
      new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

    const start = `${date}T00:00:00`;
    const end = `${date}T23:59:59`;

    const { data: emails, error } = await supabase
      .from("tracked_emails")
      .select(
        `
        employee_email,
        first_response_minutes
      `
      )
      .gte("received_at", start)
      .lte("received_at", end)
      .not("first_response_minutes", "is", null);

    if (error) throw error;

    if (!emails || emails.length === 0) {
      return res.json({
        success: true,
        date,
        inserted: 0,
        note: "No first-responder emails for this date"
      });
    }

    const byEmployee = {};

    for (const e of emails) {
      if (!byEmployee[e.employee_email]) {
        byEmployee[e.employee_email] = {
          total: 0,
          breaches: 0,
          sumMinutes: 0
        };
      }

      byEmployee[e.employee_email].total += 1;
      byEmployee[e.employee_email].sumMinutes += e.first_response_minutes;

      if (e.first_response_minutes > SLA_MINUTES) {
        byEmployee[e.employee_email].breaches += 1;
      }
    }

    const rows = Object.entries(byEmployee).map(
      ([employee_email, v]) => ({
        date,
        employee_email,
        total_first_responses: v.total,
        avg_first_response_minutes: Math.round(
          v.sumMinutes / v.total
        ),
        sla_breaches: v.breaches,
        sla_target_minutes: SLA_MINUTES
      })
    );

    const { error: insertError } = await supabase
      .from("daily_first_responder_metrics")
      .upsert(rows, {
        onConflict: "date,employee_email"
      });

    if (insertError) throw insertError;

    return res.json({
      success: true,
      date,
      inserted: rows.length
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Aggregation failed",
      message: err.message
    });
  }
}
