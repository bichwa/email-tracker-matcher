import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SLA_MINUTES = 15;

export default async function handler(req, res) {
  try {
    // Auth
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Date handling
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    // Pull first responses for the day
    const { data: responses, error } = await supabase
      .from("tracked_emails")
      .select(`
        employee_email,
        first_response_at,
        received_at,
        response_time_minutes
      `)
      .eq("is_incoming", true)
      .not("first_response_at", "is", null)
      .gte("received_at", `${date}T00:00:00`)
      .lte("received_at", `${date}T23:59:59`);

    if (error) throw error;

    if (!responses || responses.length === 0) {
      return res.json({
        success: true,
        date,
        inserted: 0,
        note: "No first-responder emails for this date"
      });
    }

    // Aggregate per employee
    const byEmployee = {};

    for (const r of responses) {
      const email = r.employee_email;
      if (!email) continue;

      if (!byEmployee[email]) {
        byEmployee[email] = {
          employee_email: email,
          total: 0,
          totalMinutes: 0,
          breaches: 0
        };
      }

      byEmployee[email].total += 1;

      const minutes =
        r.response_time_minutes ??
        Math.round(
          (new Date(r.first_response_at) -
            new Date(r.received_at)) /
            60000
        );

      byEmployee[email].totalMinutes += minutes;

      if (minutes > SLA_MINUTES) {
        byEmployee[email].breaches += 1;
      }
    }

    // Prepare rows
    const rows = Object.values(byEmployee).map(e => ({
      date,
      employee_email: e.employee_email,
      total_first_responses: e.total,
      avg_first_response_minutes: Math.round(
        e.totalMinutes / e.total
      ),
      sla_breaches: e.breaches,
      sla_target_minutes: SLA_MINUTES
    }));

    // Delete existing rows for the date
    await supabase
      .from("daily_first_responder_metrics")
      .delete()
      .eq("date", date);

    // Insert fresh aggregates
    const { error: insertError } = await supabase
      .from("daily_first_responder_metrics")
      .insert(rows);

    if (insertError) throw insertError;

    return res.json({
      success: true,
      date,
      inserted: rows.length
    });
  } catch (err) {
    console.error("Aggregate error:", err);
    return res.status(500).json({
      error: "Aggregation failed",
      message: err.message
    });
  }
}