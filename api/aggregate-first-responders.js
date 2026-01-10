const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SLA_MINUTES = 15;

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const date =
    req.query.date ||
    new Date().toISOString().slice(0, 10);

  try {
    const { data: rows, error } = await supabase
      .from("tracked_emails")
      .select("*")
      .gte("received_at", `${date}T00:00:00`)
      .lte("received_at", `${date}T23:59:59`)
      .not("first_response_at", "is", null);

    if (error) {
      throw error;
    }

    if (!rows.length) {
      return res.status(200).json({
        success: true,
        date,
        inserted: 0,
        note: "No first responses for this date"
      });
    }

    const map = {};

    for (const r of rows) {
      const key = r.first_responder_email;
      if (!map[key]) {
        map[key] = {
          total: 0,
          breaches: 0,
          minutes: 0
        };
      }

      map[key].total += 1;
      map[key].minutes += r.response_time_minutes || 0;
      if (r.response_time_minutes > SLA_MINUTES) {
        map[key].breaches += 1;
      }
    }

    for (const email in map) {
      const m = map[email];
      await supabase
        .from("daily_first_responder_metrics")
        .upsert({
          date,
          employee_email: email,
          total_first_responses: m.total,
          avg_first_response_minutes: Math.round(
            m.minutes / m.total
          ),
          sla_breaches: m.breaches,
          sla_target_minutes: SLA_MINUTES
        });
    }

    res.status(200).json({
      success: true,
      date,
      inserted: Object.keys(map).length
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Aggregate failed" });
  }
};
