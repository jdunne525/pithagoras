import { test, expect, type Page, type Route } from '@playwright/test';
// Regression for: the Completed tab showing a session nothing on it selected.
// The bottom panel used to follow the selection read off the WHOLE queue, so
// opening the Completed tab (or switching to it) left the Pending tab's Task —
// never picked here — streaming in the panel under the finished Tasks' rows.
// Every session's log here carries its own stream ids and its own words, so a
// session from the other tab is seen on screen and caught.

const AT = new Date().toISOString();
type TSpec = { id: string; title: string; status: string; attempts: number };
const specs: TSpec[] = [
  { id: "tP", title: "Still queued task", status: "pending", attempts: 1 },
  { id: "tA", title: "First done task here", status: "completed", attempts: 3 },
  { id: "tB", title: "Second done task here", status: "completed", attempts: 2 },
];
function task(s: TSpec): any {
  return {
    id: s.id, workspace: "/w/site", title: s.title, description: "", status: s.status,
    attempts: s.attempts, max_attempts: 5, created_at: AT, started_at: AT,
    completed_at: s.status === "completed" ? AT : null, updated_at: AT, position: 0,
  };
}
// One session's whole log: two answers, each its own stream, both named for
// the session they belong to.
function sse(sid: string): string {
  const ev = (seq: number, type: string, payload: any) =>
    "data: " + JSON.stringify({ seq, type, payload }) + "\n\n";
  return (
    ev(1, "agent_start", {}) +
    ev(2, "message_end", {
      streamId: `r-${sid}`,
      message: { role: "assistant", content: [{ type: "text", text: `FIRST-${sid.toUpperCase()}` }] },
    }) +
    ev(3, "message_end", {
      streamId: `s-${sid}`,
      message: { role: "assistant", content: [{ type: "text", text: `LAST-${sid.toUpperCase()}` }] },
    })
  );
}
// The latest attempt's session drives the panel: tP -> tPa, tA -> tAc, tB -> tBb.
const OWN = { tP: "LAST-TPA", tA: "LAST-TAC", tB: "LAST-TBB" };

async function mock(page: Page) {
  await page.route("**/api/**", async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/auth/status") return route.fulfill({ json: { authed: true, authRequired: false } });
    if (p === "/api/sessions") return route.fulfill({ json: { sessions: [], executor: "host" } });
    if (p === "/api/models") return route.fulfill({ json: { models: [{ id: "m", name: "Model" }], providers: {} } });
    if (p === "/api/features/flags") return route.fulfill({ json: { subagent: { enabled: false }, understory: { enabled: false } } });
    if (p.endsWith("/tasks")) return route.fulfill({ json: route.request().method() === "GET" ? specs.map(task) : task(specs[0]) });
    if (p.endsWith("/queue/status")) return route.fulfill({ json: { running: false } });
    if (p.endsWith("/attempts")) {
      const id = new URL(route.request().url()).pathname.split("/").at(-2);
      const spec = specs.find((s) => s.id === id)!;
      const letters = ["a", "b", "c", "d", "e"];
      const list = Array.from({ length: spec.attempts }, (_, i) => ({
        id: `${id}_attempt${i + 1}`,
        session_id: `${id}${letters[i]}`,
        attempt_number: i + 1,
      }));
      return route.fulfill({ json: list });
    }
    if (p.endsWith("/instructions")) return route.fulfill({ json: { text: "" } });
    if (/\/sessions\/[^/]+\/events/.test(p)) {
      const sid = new URL(route.request().url()).pathname.split("/").at(-2);
      return route.fulfill({
        headers: { "Content-Type": "text/event-stream" },
        body: sse(sid),
      });
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem("pithagoras.setup", "done");
  });
}

test("the Completed tab shows a finished task's own history", async ({ page }) => {
  const body = () => page.evaluate(() => document.body.innerText);
  // The panel holds one Task's session and nothing else's.
  const showOnly = async (id: string) => {
    const text = await body();
    for (const [other, marker] of Object.entries(OWN)) {
      if (other === id) continue;
      expect(text).not.toContain(marker);
    }
  };

  await page.clock.install();
  await mock(page);
  await page.goto("http://127.0.0.1:5191/projects/Foo/tasks");

  // The Pending tab opens on its first queued Task, and shows nothing else's.
  await expect(page.locator("li[data-task-id]")).toHaveCount(1, { timeout: 10000 });
  await expect.poll(body, { timeout: 10000 }).toContain(OWN.tP);
  await showOnly("tP");

  // Opening the Completed tab, with no row picked yet, must not leave the queued
  // Task's session in the panel: it lists finished Tasks, so the panel reads one
  // of them.
  await page.getByRole("button", { name: /^Completed \d+$/ }).click();
  await expect(page.locator("li[data-task-id]")).toHaveCount(2, { timeout: 10000 });
  await expect.poll(body, { timeout: 10000 }).toContain(OWN.tA);
  await showOnly("tA");

  // Picking a finished Task here opens THAT row's history.
  await page.locator("li[data-task-id='tB']").click();
  await expect.poll(body, { timeout: 10000 }).toContain(OWN.tB);
  await showOnly("tB");

  // Back to Pending: the queued Task's session is what shows, and neither
  // finished Task's is carried over from the tab left behind.
  await page.getByRole("button", { name: /^Pending \d+$/ }).click();
  await expect.poll(body, { timeout: 10000 }).toContain(OWN.tP);
  await showOnly("tP");
});
