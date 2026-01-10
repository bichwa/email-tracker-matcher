// api/ingest.js
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SLA_MINUTES = 15;

/* ---------------------------------------------
   CONFIG
---------------------------------------------- */
const TEAM_INBOX = "team@solvit.co.ke";
const SYSTEM_SENDERS = ["solvit@solvit.com"];
const SYSTEM_SUBJECT_PATTERNS = [
  "valuation status update",
  "valuation request",
  "pending",
  "callback"
];

/* ---------------------------------------------
   HELPERS
---------------------------------------------- */
function minutesBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 60000);
}

function isSystemEmail(from, subject) {
  if (SYSTEM_SENDERS.includes(from)) return true;
  if (!subject) return false;
  return SYSTEM_SUBJECT_PATTERNS.some(p =>
    subject.toLowerCase().includes(p)
  );
}

function detectNamedEmployee(subject, body, employees) {
  const text = `${subject || ""} ${body || ""}`.toLowerCase();
  return employees.find(e =>
    text.includes(e.name.toLowerCase())
  );
}

/* ---------------------------------------------
   MAIN
---------------------------------------------- */
export default async function handler(req, res) {
  try {
    if (
      req.headers.authorization !==
      `Bearer ${process.env.CRON_SECRET}`
    ) {
      return res.status(401).json({ error: "unauthorized" });
    }

    /* -----------------------------------------
       Load employees + assignments
    ------------------------------------------ */
    const { data: employees } = await supabase
      .from("employees")
      .select("email, name");

    const { data: assignments } = await supabase
      .from("team_assignments")
      .select("*")
      .lte("start_at", new Date().toISOString())
      .or(`end_at.is.null,end_at.gt.${new Date().toISOString()}`)
      .limit(1);

    const activeAssignment = assignments?.[0] || null;

    /* -----------------------------------------
       Fetch emails from Microsoft Graph
    ------------------------------------------ */
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default"
      })
    );

    const token = tokenRes.data.access_token;

    const mailRes = await axios.get(
      "https://graph.microsoft.com/v1.0/users/team@solvit.co.ke/messages?$top=50",
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    const messages = mailRes.data.value;

    /* -----------------------------------------
       Process messages
    ------------------------------------------ */
    for (const msg of messages) {
      const from = msg.from?.emailAddress?.address;
      const subject = msg.subject || "";
      const body = msg.bodyPreview || "";
      const receivedAt = msg.receivedDateTime;

      if (isSystemEmail(from, subject)) continue;

      let scenario = null;
      let assignedEmail = null;

      /* Scenario 1 */
      const named = detectNamedEmployee(subject, body, employees);
      if (msg.toRecipients.some(r => r.emailAddress.address === TEAM_INBOX) && named) {
        scenario = "TEAM_TAGGED_PERSON";
        assignedEmail = named.email;
      }

      /* Scenario 2 */
      if (!scenario && msg.toRecipients.some(r => r.emailAddress.address === TEAM_INBOX)) {
        scenario = "TEAM_GENERAL";
        assignedEmail = activeAssignment?.employee_email || null;
      }

      /* Scenario 3 */
      if (!scenario) {
        scenario = "DIRECT_PERSONAL";
        assignedEmail = msg.toRecipients[0]?.emailAddress?.address;
      }

      /* Insert */
      await supabase.from("tracked_emails").upsert({
        graph_message_id: msg.id,
        subject,
        client_email: from,
        employee_email: assignedEmail,
        received_at: receivedAt,
        scenario,
        has_response: false,
        sla_minutes: SLA_MINUTES
      });
    }

    res.json({ ok: true, ingested: messages.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
