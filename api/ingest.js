import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;

const TEAM_INBOX = "team@solvit.com";
const SLA_MINUTES = 15;

async function getGraphToken() {
  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default"
    })
  );
  return res.data.access_token;
}

function isSystemEmail(msg) {
  const from = msg.from?.emailAddress?.address || "";
  const subject = (msg.subject || "").toLowerCase();
  if (from.includes("solvit@")) return true;
  if (subject.includes("valuation status")) return true;
  if (subject.includes("request is pending")) return true;
  return false;
}

function isSolverEmail(msg) {
  const subject = (msg.subject || "").toLowerCase();
  const hasAttachment = msg.hasAttachments;
  if (hasAttachment && subject.length < 15) return true;
  if (subject === "" || subject.includes("attached")) return true;
  return false;
}

function detectNamedPerson(body, employees) {
  const text = body.toLowerCase();
  return employees.find(e =>
    text.includes(e.name.toLowerCase())
  );
}

async function getCurrentTeamAssignment(receivedAt) {
  const { data } = await supabase
    .from("team_assignments")
    .select("*")
    .lte("start_at", receivedAt)
    .gte("end_at", receivedAt)
    .limit(1)
    .single();

  return data?.employee_email || null;
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = await getGraphToken();
  const headers = { Authorization: `Bearer ${token}` };

  const { data: employees } = await supabase
    .from("employees")
    .select("email, name");

  const inboxes = [TEAM_INBOX, ...employees.map(e => e.email)];
  let inserted = 0;

  for (const inbox of inboxes) {
    const url = `https://graph.microsoft.com/v1.0/users/${inbox}/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc`;
    const resp = await axios.get(url, { headers });

    for (const msg of resp.data.value) {
      if (isSystemEmail(msg)) continue;
      if (isSolverEmail(msg)) continue;

      const receivedAt = msg.receivedDateTime;
      let scenario = "team_unassigned";
      let employeeEmail = inbox === TEAM_INBOX ? null : inbox;

      if (inbox === TEAM_INBOX) {
        const named = detectNamedPerson(
          msg.body?.content || "",
          employees
        );
        if (named) {
          scenario = "team_named";
          employeeEmail = named.email;
        } else {
          scenario = "team_assigned";
          employeeEmail = await getCurrentTeamAssignment(receivedAt);
        }
      } else {
        scenario = "personal";
      }

      const record = {
        graph_message_id: msg.id,
        subject: msg.subject,
        from_email: msg.from.emailAddress.address,
        to_email: inbox,
        client_email: msg.from.emailAddress.address,
        employee_email: employeeEmail,
        received_at: receivedAt,
        is_incoming: true,
        scenario,
        has_response: false,
        sla_breached: false
      };

      const { error } = await supabase
        .from("tracked_emails")
        .upsert(record, { onConflict: "graph_message_id" });

      if (!error) inserted++;
    }
  }

  res.json({ ok: true, inserted });
}
