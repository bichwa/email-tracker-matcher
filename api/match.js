// Email Tracker Matcher — Phase 4B
// Matches incoming emails to FIRST response only

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = Date.now();

  // 1. Fetch incoming emails that have NO response yet
  const { data: incoming, error } = await supabase
    .from('tracked_emails')
    .select('*')
    .eq('is_incoming', true)
    .eq('has_response', false)
    .order('received_at', { ascending: true })
    .limit(200);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  let matchedCount = 0;

  for (const email of incoming) {
    let response = null;

    // 2. Try conversation match (BEST)
    if (email.conversation_id) {
      const { data } = await supabase
        .from('tracked_emails')
        .select('*')
        .eq('conversation_id', email.conversation_id)
        .eq('is_incoming', false)
        .gte('received_at', email.received_at)
        .order('received_at', { ascending: true })
        .limit(1);

      if (data?.length) response = data[0];
    }

    // 3. Fallback — same client within 24h
    if (!response) {
      const windowEnd = new Date(
        new Date(email.received_at).getTime() + 24 * 60 * 60 * 1000
      ).toISOString();

      const { data } = await supabase
        .from('tracked_emails')
        .select('*')
        .eq('is_incoming', false)
        .eq('client_email', email.client_email)
        .gte('received_at', email.received_at)
        .lte('received_at', windowEnd)
        .order('received_at', { ascending: true })
        .limit(1);

      if (data?.length) response = data[0];
    }

    if (!response) continue;

    // 4. Calculate response time
    const minutes =
      Math.round(
        (new Date(response.received_at) -
          new Date(email.received_at)) / 60000
      );

    // 5. Lock FIRST responder
    await supabase
      .from('tracked_emails')
      .update({
        has_response: true,
        responded_at: response.received_at,
        response_time_minutes: minutes,
        first_response_at: response.received_at,
        first_responder_email: response.employee_email
      })
      .eq('id', email.id);

    matchedCount++;
  }

  res.json({
    success: true,
    checked: incoming.length,
    matched: matchedCount,
    duration_seconds: ((Date.now() - startedAt) / 1000).toFixed(2)
  });
};
