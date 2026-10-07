import { test, expect, type Page } from '@playwright/test';

/**
 * Repro: clicking a completed task should show THAT task's session history,
 * not another task's (e.g. always the last one run).
 */
const AT = new Date().toISOString();

function task(id: string, title: string): any {
  return {
    id, workspace: "/w/site", title, description: "", status: "completed",
    attempts: 1, max_attempts: 3, created_at: AT, started_at: AT,
    completed_at: AT, updated_at: AT, position: 0,
  };
}

function sse(text: string): string {
  return `data: ${JSON.stringify({ seq: 1, type: "message_end", payload: { streamId: "reply", message: { role: "assistant", content: [{ type: "text", text }] } } })}\n\n`;
}

async function mock(page: Page) {
  const tasks = [ task("tA", "First task here"), task("tB", "Second task here") ];
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/auth/status") return route.fulfill({ json: { authed: true, authRequired: false } });
    if (p === "/api/sessions") return route.fulfill({ json: { sessions: [], executor: "host" } });
    if (p === "/api/models") return route.fulfill({ json: { models: [{ id: "m", name: "Model" }], providers: {} } });
    if (p === "/api/features/flags") return route.fulfill({ json: { subagent: { enabled: false }, understory: { enabled: false } } });
    if (p.endsWith("/tasks")) {
      if (route.request().method() === "GET") return route.fulfill({ json: tasks });
      return route.fulfill({ json: tasks[0] });
    }
    if (p.endsWith("/queue/status")) return route.fulfill({ json: { running: false } });
    if (p.endsWith("/attempts")) {
      const id = new URL(route.request().url()).pathname.split("/").at(-2);
      return route.fulfill({ json: [{ id: `a${id}`, session_id: id.toLowerCase(), attempt_number: 1 }] });
    }
    if (p.endsWith("/instructions")) return route.fulfill({ json: { text: "" } });
    if (/\/sessions\/[^/]+\/events/.test(p)) {
      const sid = new URL(route.request().url()).pathname.split("/").at(-2);
      return route.fulfill({ headers: { "Content-Type": "text/event-stream" }, body: sse(`TRANSCRIPT-${sid.toUpperCase()}`) });
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem("pithagoras.setup", "done");
  });
}

test("clicking a completed task shows its own history", async ({ page }) => {
  await page.clock.install();
  await mock(page);
  await page.goto("http://127.0.0.1:5191/projects/Foo/tasks");
  await page.getByRole('button', { name: /Completed/i }).click();
  await expect(page.locator("li[data-task-id]")).toHaveCount(2, { timeout: 10000 });

  await page.locator("li[data-task-id='tB']").click();
  await expect.poll(async () => await page.evaluate(() => document.body.innerText), { timeout: 10000 }).toContain("TRANSCRIPT-TB");

  await page.locator("li[data-task-id='tA']").click();
  await expect.poll(async () => await page.evaluate(() => document.body.innerText), { timeout: 10000 }).toContain("TRANSCRIPT-TA");

  await page.locator("li[data-task-id='tB']").click();
  await expect.poll(async () => await page.evaluate(() => document.body.innerText), { timeout: 10000 }).toContain("TRANSCRIPT-TB");
});
