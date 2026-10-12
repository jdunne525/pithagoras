import { test, expect, type Page, type Route } from '@playwright/test';
// Regression for: reading a Task's session history showing another Task's too.
// The specs beside this one mocked every session's stream with the same `reply`
// stream id, so a transcript that kept the session read before would fold the
// two messages into one bubble and pass by accident. Here every session's log
// carries its own stream ids and its own words, so anything left over from the
// session before is seen on screen and caught.

const AT = new Date().toISOString();
type TSpec = { id: string; title: string; attempts: number };
function task(s: TSpec): any {
  return {
    id: s.id, workspace: "/w/site", title: s.title, description: "", status: "completed",
    attempts: s.attempts, max_attempts: 5, created_at: AT, started_at: AT,
    completed_at: AT, updated_at: AT, position: 0,
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

async function mock(page: Page) {
  const specs: TSpec[] = [
    { id: "tA", title: "First task here", attempts: 3 },
    { id: "tB", title: "Second task here", attempts: 2 },
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

test("a task's history carries nothing from the session read before it", async ({ page }) => {
  await page.clock.install();
  await mock(page);
  await page.goto("http://127.0.0.1:5191/projects/Foo/tasks");
  await page.getByRole("button", { name: /Completed/i }).click();
  await expect(page.locator("li[data-task-id]")).toHaveCount(2, { timeout: 10000 });

  // Each Task's latest attempt drives its own session: tA -> tAc, tB -> tBb.
  const own: Record<string, string> = { tA: "TAC", tB: "TBB" };
  for (const id of Object.keys(own)) {
    await page.locator(`li[data-task-id='${id}']`).click();
    const here = own[id];
    await expect.poll(
      async () => await page.evaluate(() => document.body.innerText),
      { timeout: 10000 },
    ).toContain(`LAST-${here}`);
    // The other Task's session, under either of its bubbles, must not be in
    // the panel once this Task is open.
    const other = Object.values(own).find((v) => v !== here)!;
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(`-${other}`);
  }
});
