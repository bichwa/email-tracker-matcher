import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SLA_MINUTES = 15;

/* ---------- helpers ---------- */

function isSystemEmail(msg) {
  const from = msg.from?.emailAddress?.address?.toLowerCase() || "";
  const subject = (msg.subject || "").toLowerCase();

  if (from.includes("solvit@")) return true;
  if (subject.includes("valuation status")) return true;
  if (subject.includes("valuation request")) return true;

  return false;
}

function isSolverEmail(msg) {
  const subject = (msg.subject || "").toLowerCase();
  const hasAttachment = msg.hasAttachments;

  if (hasAttachment && subject.length < 15) return true;
  if (subject === "" || subject === "document") return true;

  return false;
}

function detectNamedPerson(body, employees) {
  const text = body.toLowerCase();
  return employees.find(e =>
    text.includes(e.name.toLowerCase())
  );
}

/* ---------- graph auth ---------- */

async function getGraphToken() {
  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default"
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return res.data.access_token;
}

/* ---------- main handler ---------- */

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const token = await getGraphToken();

    const { data: employees } = await supabase
      .from("employees")
      .select("email, name");

    const inboxRes = await axios.get(
      "https://graph.microsoft.com/v1.0/users/team@solvit.co.ke/mailFolders/inbox/messages?$top=50",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    for (const msg of inboxRes.data.value) {
      if (isSystemEmail(msg)) continue;
      if (isSolverEmail(msg)) continue;

      const fromEmail = msg.from.emailAddress.address.toLowerCase();
      const body = msg.body?.content || "";

      const addressed = detectNamedPerson(body, employees);

      let scenario = "TEAM_UNASSIGNED";
      let employeeEmail = null;

      if (!msg.toRecipients.some(r => r.emailAddress.address.includes("team@"))) {
        scenario = "PERSONAL_EMAIL";
        employeeEmail = msg.toRecipients[0].emailAddress.address.toLowerCase();
      } else if (addressed) {
        scenario = "TEAM_ADDRESSED";
        employeeEmail = addressed.email;
      }

      await supabase.from("tracked_emails").upsert({
        graph_message_id: msg.id,
        subject: msg.subject,
        from_email: fromEmail,
        client_email: fromEmail,
        employee_email: employeeEmail,
        received_at: msg.receivedDateTime,
        is_incoming: true,
        has_response: false,
        scenario
      });
    }

    res.json({ ok: true, ingested: inboxRes.data.value.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
