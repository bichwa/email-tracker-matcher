// api/ingest.js
// Microsoft Graph ingestion with full scenario handling
// Scenarios covered:
// 1. Client to team with specific person tagged
// 2. Client to team without person tagged, uses assignment
// 3. Client to personal mailbox
// 4. System generated emails excluded
// 5. Solver emails excluded

const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const TEAM_ADDRESS = "team@solvit.co.ke";
const SLA_MINUTES = 15;

const SYSTEM_SENDERS = [
  "solvit@solvit.com"
];

const SYSTEM_SUBJECT_PATTERNS = [
  "valuation status update",
  "valuation request",
  "pending"
];

const SOLVER_SUBJECT_PATTERNS = [
  "attached",
  "document from",
  "(no subject)"
];

async function getGraphToken() {
  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default"
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return res.data.access_token;
}

function isSystemEmail(from, subject) {
  if (SYSTEM_SENDERS.includes(from)) return true;
  if (!subject) return false;
  return SYSTEM_SUBJECT_PATTERNS.some(p =>
    subject.toLowerCase().includes(p)
  );
}

function isSolverEmail(from, subject, hasAttachments) {
  if (!hasAttachments) return false;
  if (!subject) return true;
  return SOLVER_SUBJECT_PATTERNS.some(p =>
    subject.toLowerCase().includes(p)
  );
}

async function detectTaggedEmployee(subject, bodyPreview) {
  const { data: employees } = await supabase
    .from("employees")
    .select("name,email");

  const text = `${subject || ""} ${bodyPreview || ""}`.toLowerCase();

  const hit = employees.find(e =>
    text.includes(e.name.toLowerCase())
  );

  return hit ? hit.email : null;
}

async function getAssignedTeamMember(receivedAt) {
  const { data } = await supabase
    .from("team_assignments")
    .select("employee_email")
    .lte("start_at", receivedAt)
    .gte("end_at", receivedAt)
    .order("start_at", { ascending: false })
    .limit(1);

  return data && data.length ? data[0].employee_email : null;
}

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const token = await getGraphToken();

    const graph = axios.create({
      baseURL: "https://graph.microsoft.com/v1.0",
      headers: { Authorization: `Bearer ${token}` }
    });

    const inbox = await graph.get(
      "/users/team@solvit.co.ke/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc"
    );

    let inserted = 0;

    for (const m of inbox.data.value) {
      const from = m.from?.emailAddress?.address?.toLowerCase();
      const to = m.toRecipients.map(r =>
        r.emailAddress.address.toLowerCase()
      );
      const subject = m.subject;
      const receivedAt = m.receivedDateTime;
      const hasAttachments = m.hasAttachments;

      if (isSystemEmail(from, subject)) continue;
      if (isSolverEmail(from, subject, hasAttachments)) continue;

      const isTeamMail = to.includes(TEAM_ADDRESS);
      let employeeEmail = null;

      if (isTeamMail) {
        const tagged = await detectTaggedEmployee(
          subject,
          m.bodyPreview
        );
        if (tagged) {
          employeeEmail = tagged;
        } else {
          employeeEmail = await getAssignedTeamMember(receivedAt);
        }
      } else {
        employeeEmail = to.find(t =>
          t.endsWith("@solvit.co.ke")
        );
      }

      const { error } = await supabase
        .from("tracked_emails")
        .upsert(
          {
            graph_message_id: m.id,
            conversation_id: m.conversationId,
            subject,
            from_email: from,
            to_email: to.join(","),
            received_at: receivedAt,
            is_incoming: true,
            has_response: false,
            client_email: from,
            employee_email: employeeEmail
          },
          { onConflict: "graph_message_id" }
        );

      if (!error) inserted++;
    }

    res.json({ ok: true, inserted });
  } catch (err) {
    console.error("Ingest error", err.message);
    res.status(500).json({ error: err.message });
  }
};
