const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
  }

  return createClient(url, key);
}

module.exports = async (req, res) => {
  try {
    // Auth guard (cron-job.org / manual testing)
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Just a smoke test for now
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("tracked_emails")
      .select("id")
      .limit(1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      ok: true,
      checkedTrackedEmails: true,
      sampleCount: data?.length || 0
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
