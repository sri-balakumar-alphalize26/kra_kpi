/* The 369 AI Assistant's ready-made questions (AiAssistant.jsx): the FAQ
   sections, the one-tap strip above the input, and the questions offered for a
   person. Every question here is one the server's rule engine understands
   (kpi_ai_assistant_engine.py) — keep it that way when adding more.
   `fill` items put text in the input instead of asking. */
export const FAQ = [
  { key: "today", label: "Today", items: [
    "Summary of today", "Who started their workday?", "Who hasn't started their workday?",
    "Who is running a task?", "Any alerts?", "Completed tasks today",
  ] },
  { key: "tasks", label: "Tasks", items: [
    "Who has paused tasks?", "Urgent tasks not started", "Important tasks not started",
    "What's waiting for my approval?", "Overdue tasks", "Tasks over estimate",
    "How many tasks are not started?", "Unassigned tasks",
  ] },
  { key: "people", label: "People", people: true },
  { key: "performance", label: "Performance", items: [
    "Top performers this week", "Top performers this month", "Who has the most paused tasks?",
    "Completed tasks this week", "Completed tasks last month", "Summary of this month",
  ] },
  /* A live search box (AiAssistant FindTasks): tap a task to get its status. */
  { key: "find", label: "Find a task", find: true },
];

/* One tap, always above the input once a chat has started. */
export const QUICK = [
  ["Summary", "Summary of today"], ["Paused", "Who has paused tasks?"], ["Approvals", "What's waiting for my approval?"],
  ["Overdue", "Overdue tasks"], ["Workday", "Who started their workday?"], ["Alerts", "Any alerts?"],
  ["Top this week", "Top performers this week"],
];

export const personQuestions = (name) => [
  `How is ${name} doing?`, `${name}'s paused tasks`, `${name}'s tasks not started`,
  `${name}'s completed tasks this week`, `Is ${name} online?`,
];

/* Every askable FAQ question, for type-ahead. */
export const ALL_QUESTIONS = FAQ.flatMap((s) => (s.items || []).filter((q) => typeof q === "string"));

/* Up to `max` questions matching what is being typed: every typed word must
   appear (FAQ first, then the person questions for names that match). */
export function suggest(text, people = [], max = 5) {
  const words = String(text || "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const hit = (q) => { const l = q.toLowerCase(); return words.every((w) => l.includes(w)); };
  const out = ALL_QUESTIONS.filter(hit);
  for (const p of people) {
    if (out.length >= max) break;
    const n = (p.name || "").toLowerCase();
    if (words.some((w) => n.split(/\s+/).some((part) => part.startsWith(w)))) {
      for (const q of personQuestions(p.name)) if (out.length < max && !out.includes(q)) out.push(q);
    }
  }
  return out.slice(0, max);
}
