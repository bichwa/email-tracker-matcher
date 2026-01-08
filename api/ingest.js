import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SLA_MINUTES = 15;

const SYSTEM_SENDERS = [
  "solvit@solvit.com"
];

const SYSTEM_SUBJECT_PATTERNS = [
  "valuation status",
  "valuation request",
  "pending",
  "callback"
];

const SOLVER_SUBJECT_PATTERNS = [
  "attached",
  "document",
  "evaluation letter"
];

function isSystemEmail(email) {
  if (!email) return false;
  return SYSTEM_SENDERS.some(s =>
    email.toLowerCase().includes(s)
  );
}

function isSystemSubject(subject) {
  if (!subject) return false;
  return SYSTEM_SUBJECT_PATTERNS.some(p =>
    subject.toLowerCase().includes(p)
  );
}

function isSolverEmail(subject, hasAttachments) {
  if (!subject && hasAttachments) return true;
  if (!subject) return false;
  return SOLVER_SUBJECT_PATTERNS.some(p =>
    subject.toLowerCase().includes(p)
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
    })
  );
  return res.data.access_token;
}

function detectNamedEmployee(subject, body, employees) {
  const text = `${subject || ""} ${body || ""}`.toLowerCase();
  return employees.find(e =>
    text.includes(e.name.toLowerCase())
  );
}

async function getActiveTeamAssignment(receivedAt) {
  const { data } = await supabase
    .from("team_assignments")
    .select("employee_email")
    .lte("start_at", receivedAt)
    .or(`end_at.is.null,end_at.gte.${receivedAt}`)
    .order("start_at", { ascending: false })
    .limit(1);

  return data?.[0]?.employee_email || null;
}

export default async function handler(req, res) {
  if (
    req.headers.authorization !==
    `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const token = await getGraphToken();

    const { data: employees } = await supabase
      .from("employees")
      .select("email, name");

    const graph = await axios.get(
      "https://graph.microsoft.com/v1.0/users/team@solvit.co.ke/mailFolders/Inbox/messages?$top=50",
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    let inserted = 0;

    for (const msg of graph.data.value) {
      const from = msg.from?.emailAddress?.address;
      const subject = msg.subject || null;
      const receivedAt = msg.receivedDateTime;
      const hasAttachments = msg.hasAttachments;
      const body = msg.body?.content || "";

      if (isSystemEmail(from)) continue;
      if (isSystemSubject(subject)) continue;
      if (isSolverEmail(subject, hasAttachments)) continue;

      let scenario = "team_unassigned";
      let employeeEmail = null;

      const named = detectNamedEmployee(
        subject,
        body,
        employees
      );

      if (named) {
        scenario = "team_named";
        employeeEmail = named.email;
      } else {
        employeeEmail = await getActiveTeamAssignment(receivedAt);
        scenario = "team_assigned";
      }

      await supabase.from("tracked_emails").upsert({
        graph_message_id: msg.id,
        conversation_id: msg.conversationId,
        subject,
        from_email: from,
        to_email: "team@solvit.co.ke",
        received_at: receivedAt,
        is_incoming: true,
        has_response: false,
        client_email: from,
        employee_email: employeeEmail,
        scenario,
        sla_minutes: SLA_MINUTES
      });

      inserted++;
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
