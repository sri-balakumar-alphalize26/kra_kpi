"use client";
import { useEffect, useMemo, useState } from "react";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";
import { ErrorState } from "@/components/ui";
import AiAssistant from "./AiAssistant";
import DashboardTop from "./DashboardTop";

/* The Dashboard (/dashboard), the "369 AI Admin Dashboard" design: the 369 AI
   Assistant docked on the left (sticky, like the sidebar), and on the right
   only two boxes — Client details and Employees today (DashboardTop.jsx).
   Three reads:
     /kpi_owner/certified_by_client  the client list for the picker
     /kpi_owner/live_tracking        presence and what each person is doing now
     /kra_kpi/dashboard/overview     per-person hours today and done this week
   Admins only (dashboard/layout.jsx). The page before this one (headline
   cards, charts, deadlines, invoices…) is in git history / the
   Dashboard.jsx.before-trim backup. */
export default function Dashboard() {
  const ov = useResource(A.DASHBOARD_PATH, {}, { ttl: 30000, pollMs: 60000 });
  const live = useResource(A.LIVE_TRACKING_PATH, {}, { ttl: 5000, pollMs: 30000 });
  const cert = useResource(A.CERTIFIED_PATH, {}, { ttl: 30000 });

  const o = ov.data?.status ? ov.data : null;
  const lt = live.data?.status ? live.data : null;
  const clients = cert.data?.status ? cert.data.clients || [] : null;
  const failed = (live.data?.status === false && { message: live.data.message || "Could not load the employees." }) || (live.error && !live.data && live.error);

  const people = useMemo(() => buildPeople(lt, o), [lt, o]);

  /* The AI panel tucks away behind an arrow tab (UltraViewer-style), giving
     Client details and Employees the full width. Closed by default — the two
     boxes are what the page is for; the AI is one click away. The person's
     own choice is remembered per browser. */
  const [aiOpen, setAiOpen] = useState(false);
  useEffect(() => { try { setAiOpen(localStorage.getItem("kpi.db.ai") === "1"); } catch (e) {} }, []);
  const toggleAi = () => setAiOpen((v) => { try { localStorage.setItem("kpi.db.ai", v ? "0" : "1"); } catch (e) {} return !v; });
  /* Phones stack the page and have no tab: the panel is always there. */
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const on = () => setNarrow(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const shown = aiOpen || narrow;

  return (
    <div className={`db-wrap ${shown ? "" : "ai-closed"}`}>
      <div className="db-aiwrap" id="db-ai" aria-hidden={!shown} inert={!shown}>
        <AiAssistant variant="panel" />
      </div>
      <button type="button" className="db-aitab" aria-expanded={aiOpen} aria-controls="db-ai" onClick={toggleAi}
        title={aiOpen ? "Hide the AI Assistant" : "Show the AI Assistant"}>
        <span className="db-aiarrow" aria-hidden="true">{aiOpen ? "◀" : "▶"}</span>
        <span className="db-ailabel">AI Assistant</span>
      </button>
      <section className="db-det" aria-label="Clients and employees">
        {failed && <ErrorState error={failed} onRetry={live.refresh} />}
        <DashboardTop clients={clients} people={people} onChanged={() => { live.refresh(); ov.refresh(); }} />
      </section>
    </div>
  );
}

/* Live tracking rows merged with the overview's per-person numbers
   (productive_today, done_week), working people first. */
function buildPeople(lt, o) {
  if (!lt) return null;
  const stats = new Map((o?.people || []).map((p) => [p.user_id, p]));
  const rank = (r) => (r.activity_kind === "task" ? 0 : r.started ? 1 : r.attendance === "present" || r.attendance === "late" ? 2 : 3);
  return (lt.rows || []).map((r) => ({ ...r, ...(stats.get(r.user_id) || {}), user_id: r.user_id }))
    .sort((a, b) => rank(a) - rank(b) || (a.name || "").localeCompare(b.name || ""));
}
