// email-tracker-matcher/api/ingest.js
// Ingest emails from Microsoft Graph into tracked_emails
// Rolling window ingestion with deduplication

const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Config
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const LOOKBACK_HOURS = 48;

// Get Microsoft Graph access token
async function getGraphToken() {
  const tokenUrl = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append("client_id", process.env.AZURE_CLIENT_ID);
  params.append("client_secret", process.env.AZURE_CLIENT_SECRET);
  params.append("grant_type", "client_credentials");
  params.append("scope", GRAPH_SCOPE);

  const res = await axios.post(tokenUrl, params);
  return res.data.access_token;
}

// Fetch messages for one mailbox
async function fetchMessages(token, mailbox) {
  const since = new Date(
    Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000
  ).toISOString();

  const url =
    `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders/Inbox/messages` +
    `?$top=50&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${since}`;

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return res.data.value || [];
}

module.exports = async (req, res) => {
  try {
    // Auth
    if (
      req.headers.authorization !==
      `Bearer ${process.env.CRON_SECRET}`
    ) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    const token = await getGraphToken();

    const monitored =
      process.env.MONITORED_EMAILS
        ?.split(",")
        .map(e => e.trim().toLowerCase())
        .filter(Boolean) || [];

    if (monitored.length === 0) {
      return res.json({
        success: true,
        inserted: 0,
        note: "No monitored emails configured"
      });
    }

    let inserted = 0;

    for (const mailbox of monitored) {
      const messages = await fetchMessages(token, mailbox);

      for (const msg of messages) {
        const graphId = msg.id;

        const { data: exists } = await supabase
          .from("tracked_emails")
          .select("id")
          .eq("graph_message_id", graphId)
          .limit(1);

        if (exists && exists.length) {
          continue;
        }

        const isIncoming =
          msg.from &&
          msg.from.emailAddress &&
          msg.from.emailAddress.address.toLowerCase() !== mailbox;

        await supabase
          .from("tracked_emails")
          .insert({
            graph_message_id: graphId,
            conversation_id: msg.conversationId,
            subject: msg.subject,
            from_email:
              msg.from?.emailAddress?.address?.toLowerCase() || null,
            client_email:
              msg.from?.emailAddress?.address?.toLowerCase() || null,
            employee_email: mailbox,
            received_at: msg.receivedDateTime,
            is_incoming: isIncoming,
            has_response: false,
            ingested_at: new Date().toISOString()
          });

        inserted++;
      }
    }

    res.json({
      success: true,
      inserted
    });
  } catch (err) {
    console.error("Ingestion error:", err);
    res.status(500).json({
      error: err.message
    });
  }
};
