import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SLA_MINUTES = 15;
const MAX_MESSAGES = 50;

const SYSTEM_SENDERS = [
  "solvit@solvit.com"
];

const SYSTEM_SUBJECT_PATTERNS = [
  "valuation status update",
  "valuation request",
  "pending"
];

function isSystemEmail(email) {
  if (!email) return false;
  return SYSTEM_SENDERS.some(s => email.toLowerCase().includes(s));
}

function isSystemSubject(subject) {
  if (!subject) return false;
  const s = subject.toLowerCase();
  return SYSTEM_SUBJECT_PATTERNS.some(p => s.includes(p));
}

function detectNamedEmployee(subject, body, employees) {
  const text = `${subject || ""} ${body || ""}`.toLowerCase();
  return employees.find(e =>
    text.includes(e.name.toLowerCase())
  );
}

async function getGraphToken() {
  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default"
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return res.data.access_token;
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const token = await getGraphToken();

    const employeesRes = await supabase
      .from("employees")
      .select("email, name");

    const employees = employeesRes.data || [];

    const inboxRes = await axios.get(
      "https://graph.microsoft.com/v1.0/users/team@solvit.com/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const messages = inboxRes.data.value || [];

    let inserted = 0;

    for (const msg of messages.slice(0, MAX_MESSAGES)) {
      if (isSystemEmail(msg.from?.emailAddress?.address)) continue;
      if (isSystemSubject(msg.subject)) continue;

      const receivedAt = new Date(msg.receivedDateTime).toISOString();

      const named = detectNamedEmployee(
        msg.subject,
        msg.body?.content,
        employees
      );

      const employeeEmail = named
        ? named.email
        : "team@solvit.com";

      const { error } = await supabase
        .from("tracked_emails")
        .upsert({
          graph_message_id: msg.id,
          conversation_id: msg.conversationId,
          subject: msg.subject,
          from_email: msg.from.emailAddress.address,
          to_email: "team@solvit.com",
          received_at: receivedAt,
          is_incoming: true,
          has_response: false,
          client_email: msg.from.emailAddress.address,
          employee_email: employeeEmail
        }, { onConflict: "graph_message_id" });

      if (!error) inserted++;
    }

    res.json({
      ok: true,
      inserted
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
