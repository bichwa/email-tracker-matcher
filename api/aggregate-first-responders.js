// Aggregate daily first responder metrics
// SAFE: read from tracked_emails, write to daily_first_responder_metrics only

const { createClient } = require('@supabase/supabase-js');

const SLA_TARGET_MINUTES = parseInt(process.env.SLA_TARGET_MINUTES || '15', 10);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const start = Date.now();

  try {
    const targetDate =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const { data: rows, error } = await supabase
      .from('tracked_emails')
      .select(`
        first_responder_email,
        response_time_minutes,
        received_at
      `)
      .not('first_responder_email', 'is', null)
      .gte('received_at', `${targetDate}T00:00:00`)
      .lte('received_at', `${targetDate}T23:59:59`);

    if (error) throw error;

    if (!rows || rows.length === 0) {
      return res.json({
        success: true,
        date: targetDate,
        inserted: 0,
        note: 'No first-responder emails for this date'
      });
    }

    const buckets = {};

    for (const r of rows) {
      const email = r.first_responder_email;

      if (!buckets[email]) {
        buckets[email] = {
          total: 0,
          times: [],
          breaches: 0
        };
      }

      buckets[email].total += 1;

      if (typeof r.response_time_minutes === 'number') {
        buckets[email].times.push(r.response_time_minutes);
        if (r.response_time_minutes > SLA_TARGET_MINUTES) {
          buckets[email].breaches += 1;
        }
      }
    }

    const payload = Object.entries(buckets).map(
      ([employee_email, stats]) => {
        const avg =
          stats.times.length > 0
            ? stats.times.reduce((a, b) => a + b, 0) /
              stats.times.length
            : null;

        return {
          date: targetDate,
          employee_email,
          total_first_responses: stats.total,
          avg_first_response_minutes: avg
            ? Number(avg.toFixed(2))
            : null,
          sla_breaches: stats.breaches,
          sla_target_minutes: SLA_TARGET_MINUTES
        };
      }
    );

    const { error: upsertError } = await supabase
      .from('daily_first_responder_metrics')
      .upsert(payload, {
        onConflict: 'date,employee_email'
      });

    if (upsertError) throw upsertError;

    res.json({
      success: true,
      date: targetDate,
      responders: payload.length,
      duration_seconds: Number(((Date.now() - start) / 1000).toFixed(2))
    });
  } catch (err) {
    console.error('Aggregation error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
