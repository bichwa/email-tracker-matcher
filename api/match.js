// api/match.js
// Email Tracker — Matcher + First Responder Metrics

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SLA_MINUTES = Number(process.env.SLA_TARGET_MINUTES || 15);

module.exports = async (req, res) => {
  try {
    // 🔐 Auth
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const start = Date.now();

    /* -------------------------------------------------------
       STEP 1 — Fetch unmatched incoming emails
    -------------------------------------------------------- */

    const { data: pending, error: pendingError } = await supabase
      .from('tracked_emails')
      .select('*')
      .eq('is_incoming', true)
      .eq('has_response', false)
      .order('received_at', { ascending: true });

    if (pendingError) throw pendingError;

    let matchedCount = 0;

    /* -------------------------------------------------------
       STEP 2 — Match first response
    -------------------------------------------------------- */

    for (const incoming of pending) {
      let response = null;

      // Strategy A — Conversation ID
      if (incoming.conversation_id) {
        const { data } = await supabase
          .from('tracked_emails')
          .select('*')
          .eq('conversation_id', incoming.conversation_id)
          .eq('is_incoming', false)
          .gte('received_at', incoming.received_at)
          .order('received_at', { ascending: true })
          .limit(1);

        if (data?.length) response = data[0];
      }

      // Strategy B — Same client within 24h
      if (!response) {
        const end = new Date(
          new Date(incoming.received_at).getTime() + 24 * 60 * 60 * 1000
        ).toISOString();

        const { data } = await supabase
          .from('tracked_emails')
          .select('*')
          .eq('client_email', incoming.client_email)
          .eq('is_incoming', false)
          .gte('received_at', incoming.received_at)
          .lte('received_at', end)
          .order('received_at', { ascending: true })
          .limit(1);

        if (data?.length) response = data[0];
      }

      if (!response) continue;

      const responseMinutes = Math.round(
        (new Date(response.received_at) -
          new Date(incoming.received_at)) /
          60000
      );

      await supabase
        .from('tracked_emails')
        .update({
          has_response: true,
          responded_at: response.received_at,
          responded_by: response.responded_by,
          response_time_minutes: responseMinutes,

          // 🔒 First responder lock
          first_response_at: response.received_at,
          first_responder_email: response.responded_by
        })
        .eq('id', incoming.id);

      matchedCount++;
    }

    /* -------------------------------------------------------
       STEP 3 — DAILY FIRST RESPONDER METRICS (FIX)
    -------------------------------------------------------- */

    const today = new Date().toISOString().split('T')[0];

    const { data: firstResponses } = await supabase
      .from('tracked_emails')
      .select(
        'first_responder_email, response_time_minutes, received_at'
      )
      .eq('is_incoming', true)
      .not('first_responder_email', 'is', null)
      .gte('received_at', `${today}T00:00:00`)
      .lte('received_at', `${today}T23:59:59`);

    const byResponder = {};

    for (const r of firstResponses || []) {
      const email = r.first_responder_email;

      if (!byResponder[email]) {
        byResponder[email] = {
          count: 0,
          totalMinutes: 0,
          breaches: 0
        };
      }

      byResponder[email].count++;
      byResponder[email].totalMinutes += r.response_time_minutes || 0;

      if ((r.response_time_minutes || 0) > SLA_MINUTES) {
        byResponder[email].breaches++;
      }
    }

    for (const email of Object.keys(byResponder)) {
      const row = byResponder[email];

      await supabase
        .from('daily_first_responder_metrics')
        .upsert(
          {
            date: today,
            first_responder_email: email,
            total_first_responses: row.count,
            avg_first_response_minutes:
              row.count > 0
                ? Number(
                    (row.totalMinutes / row.count).toFixed(2)
                  )
                : null,
            sla_breaches: row.breaches
          },
          { onConflict: 'date,first_responder_email' }
        );
    }

    /* -------------------------------------------------------
       DONE
    -------------------------------------------------------- */

    res.json({
      success: true,
      matched: matchedCount,
      duration_seconds: (
        (Date.now() - start) /
        1000
      ).toFixed(2)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
