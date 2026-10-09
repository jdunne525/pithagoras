import { test, expect, type Page, type Route } from '@playwright/test';
// Regression for: viewing a completed task showing another task's session.
// Each completed Task has several attempts; each attempt has its own session,
// so selecting a Task must render only ITS OWN latest attempt's transcript —
// never a stale transcript left over from a previously selected Task.

const AT = new Date().toISOString();
type TSpec = { id: string; title: string; attempts: number };
function task(s: TSpec): any {
  return { id: s.id, workspace: "/w/site", title: s.title, description: "", status: "completed",
    attempts: s.attempts, max_attempts: 5, created_at: AT, started_at: AT, completed_at: AT, updated_at: AT, position: 0 };
}
function sse(text: string): string {
  const payload = JSON.stringify({ seq: 1, type: "message_end", payload: { streamId: "reply", message: { role: "assistant", content: [{ type: "text", text }] } } });
  return "data: " + payload + "\n\n";
}
async function mock(page: Page) {
  const specs: TSpec[] = [
    { id: "tA", title: "First task here", attempts: 3 },
    { id: "tB", title: "Second task here", attempts: 2 },
    { id: "tC", title: "Third task here", attempts: 1 },
  ];
  const tasks = specs.map(task);
  await page.route("**/api/**", async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/auth/status") return route.fulfill({ json: { authed: true, authRequired: false } });
    if (p === "/api/sessions") return route.fulfill({ json: { sessions: [], executor: "host" } });
    if (p === "/api/models") return route.fulfill({ json: { models: [{ id: "m", name: "Model" }], providers: {} } });
    if (p === "/api/features/flags") return route.fulfill({ json: { subagent: { enabled: false }, understory: { enabled: false } } });
    if (p.endsWith("/tasks")) return route.fulfill({ json: route.request().method() === "GET" ? tasks : tasks[0] });
    if (p.endsWith("/queue/status")) return route.fulfill({ json: { running: false } });
    if (p.endsWith("/attempts")) {
      const id = new URL(route.request().url()).pathname.split("/").at(-2);
      const spec = specs.find((s) => s.id === id)!;
      // Respect the task's real attempt count so the loaded list matches the chip.
      const letters = ["a", "b", "c", "d", "e"];
      const list = Array.from({ length: spec.attempts }, (_, i) => ({
        id: `${id}_attempt${i + 1}`, session_id: `${id}${letters[i]}`, attempt_number: i + 1,
      })).sort((x, y) => x.attempt_number - y.attempt_number);
      return route.fulfill({ json: list });
    }
    if (p.endsWith("/instructions")) return route.fulfill({ json: { text: "" } });
    if (/\/sessions\/[^/]+\/events/.test(p)) {
      const sid = new URL(route.request().url()).pathname.split("/").at(-2);
      return route.fulfill({ headers: { "Content-Type": "text/event-stream" }, body: sse("TRANSCRIPT-" + sid.toUpperCase()) });
    }
    return route.continue();
  });
  await page.addInitScript(() => { localStorage.setItem("pithagoras.setup", "done"); });
}

test("each completed task renders only its own latest-attempt session", async ({ page }) => {
  await mock(page);
  await page.goto("http://127.0.0.1:5191/projects/Foo/tasks");
  await page.getByRole('button', { name: /Completed/i }).click();
  await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

  // Latest attempt of each task drives its session id -> transcript marker.
  const expected: Record<string, string> = { tA: "TRANSCRIPT-TAC", tB: "TRANSCRIPT-TBB", tC: "TRANSCRIPT-TCA" };
  for (const id of Object.keys(expected)) {
    await page.locator(`li[data-task-id='${id}']`).click();
    const marker = expected[id];
    await expect.poll(async () => (await page.evaluate(() => document.body.innerText)).includes(marker), { timeout: 10000 }).toBe(true);
    // No other task's transcript may leak into the panel after the switch.
    for (const other of Object.values(expected)) if (other !== marker) {
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(other);
    }
  }
});
