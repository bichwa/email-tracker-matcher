// Read-only endpoint: expose first responder data
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  // 🔒 Auth guard
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { data, error } = await supabase
      .from('tracked_emails')
      .select(`
        subject,
        client_email,
        employee_email,
        first_responder_email,
        first_response_at,
        response_time_minutes,
        received_at
      `)
      .is('is_incoming', true)
      .not('first_response_at', 'is', null)
      .order('received_at', { ascending: false })
      .limit(500);

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      count: data.length,
      items: data
    });
  } catch (err) {
    console.error('first-responses error:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
