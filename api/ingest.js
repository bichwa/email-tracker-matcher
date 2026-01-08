const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function getGraphToken() {
  const params = new URLSearchParams();
  params.append("client_id", CLIENT_ID);
  params.append("client_secret", CLIENT_SECRET);
  params.append("grant_type", "client_credentials");
  params.append("scope", GRAPH_SCOPE);

  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return res.data.access_token;
}

async function ingestEmails() {
  console.log("Ingest started");

  const token = await getGraphToken();

  const headers = {
    Authorization: `Bearer ${token}`
  };

  const res = await axios.get(
    `${GRAPH_BASE}/users`,
    { headers }
  );

  const users = res.data.value || [];

  for (const user of users) {
    if (!user.mail) continue;

    const mailRes = await axios.get(
      `${GRAPH_BASE}/users/${user.id}/mailFolders/inbox/messages?$top=25`,
      { headers }
    );

    const messages = mailRes.data.value || [];

    for (const msg of messages) {
      await supabase
        .from("tracked_emails")
        .upsert(
          {
            graph_message_id: msg.id,
            conversation_id: msg.conversationId,
            subject: msg.subject,
            from_email: msg.from?.emailAddress?.address,
            to_email: user.mail,
            received_at: msg.receivedDateTime,
            is_incoming: true,
            employee_email: user.mail,
            client_email: msg.from?.emailAddress?.address
          },
          { onConflict: "graph_message_id" }
        );
    }
  }

  console.log("Ingest finished");
}

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.status(200).json({
    ok: true,
    ingesting: true
  });

  ingestEmails().catch(err => {
    console.error("Ingest error:", err.message);
  });
};
