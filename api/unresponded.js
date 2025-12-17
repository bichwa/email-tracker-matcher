const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  // Auth
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Optional filter by employee
  const employee = req.query.employee?.toLowerCase();

  let query = supabase
    .from('tracked_emails')
    .select(
      `
      id,
      subject,
      client_email,
      employee_email,
      received_at,
      first_response_at
      `
    )
    .eq('is_incoming', true)
    .eq('has_response', false)
    .order('received_at', { ascending: true })
    .limit(200);

  if (employee) {
    query = query.eq('employee_email', employee);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Unresponded fetch error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  const now = Date.now();

  const items = data.map(e => {
    const ageMinutes = Math.round(
      (now - new Date(e.received_at).getTime()) / 60000
    );

    return {
      subject: e.subject,
      client_email: e.client_email,
      employee_email: e.employee_email,
      received_at: e.received_at,
      age_minutes: ageMinutes,
      sla_breached: ageMinutes > 15
    };
  });

  res.json({
    success: true,
    count: items.length,
    items
  });
};
