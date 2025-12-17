// api/unresponded.js
// READ-ONLY endpoint: SLA-breached unresponded emails

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  /* -------------------------------------------------- */
  /* Auth guard                                         */
  /* -------------------------------------------------- */
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    /* -------------------------------------------------- */
    /* SLA definition (minutes)                           */
    /* -------------------------------------------------- */
    const SLA_MINUTES = 15;

    /* -------------------------------------------------- */
    /* Query                                              */
    /* -------------------------------------------------- */
    const { data, error } = await supabase.rpc(
      'get_unresponded_emails',
      { sla_minutes: SLA_MINUTES }
    );

    if (error) {
      console.error('Unresponded query error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      success: true,
      count: data.length,
      items: data
    });

  } catch (err) {
    console.error('Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
};
