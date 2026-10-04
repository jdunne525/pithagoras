import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * Tasks page layout: when many tasks exist, the task list must stay inside its
 * allotted column and never run into the conversation's selected-session title
 * row below it. The list is a flex item inside section A, so it must be clipped
 * (scrollable) rather than expanding to full content height.
 */
const AT = new Date().toISOString();

function task(id: string, title: string, status: any = "pending"): any {
  return {
    id, workspace: "/w/site", title, description: "", status,
    attempts: 0, max_attempts: 3, created_at: AT, started_at: null,
    completed_at: null, updated_at: AT, position: 0,
  };
}

async function mockTasks(page: Page, count: number) {
  const tasks = Array.from({ length: count }, (_, i) => task(`t${i}`, `Task number ${i + 1} here`));
  let attemptsSeq = 0;
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
      const n = Math.min(attemptsSeq++, 2);
      return route.fulfill({ json: Array.from({ length: n }, (_, k) => ({ id: `a${k}`, session_id: null, attempt_number: k })) });
    }
    if (p.endsWith("/instructions")) return route.fulfill({ json: { text: "" } });
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem("pithagoras.setup", "done");
  });
}

test('the task list does not overlap the selected-session title', async ({ page }) => {
  await page.clock.install();
  await mockTasks(page, 60);
  await page.goto("/projects/Foo/tasks");

  // Section A holds the header/tabs and the scrollable list of tasks.
  // The exact conversation header carrying the selected task's title.
  const titleRow: Locator = page.locator(
    '.app-main .flex.shrink-0.items-center.gap-2.border-b.border-line.px-3.py-2',
  );

  await expect(page.locator("li[data-task-id]")).toHaveCount(60, { timeout: 10000 });
  // Select the first task so the conversation shows its title row.
  await page.locator("li[data-task-id]").first().click();
  await expect(titleRow).toBeVisible({ timeout: 10000 });

  // The list is clipped: content taller than the visible box, so it scrolls.
  await expect.poll(
    () =>
      page.evaluate(() => {
        const list = document.querySelector(
          '.app-main .flex-1.min-h-0.flex-col.border-b.border-line .overflow-y-auto',
        ) as HTMLElement | null;
        return !!list && list.scrollHeight > list.clientHeight;
      }),
    { timeout: 10000 },
  ).toBe(true);

  // The list's visible bottom stops before the title row — no overlap.
  await expect.poll(
    () =>
      page.evaluate(() => {
        const list = document.querySelector(
          '.app-main .flex-1.min-h-0.flex-col.border-b.border-line .overflow-y-auto',
        ) as HTMLElement | null;
        const titleRow = document.querySelector(
          '.app-main .flex.shrink-0.items-center.gap-2.border-b.border-line.px-3.py-2',
        ) as HTMLElement | null;
        const l = list?.getBoundingClientRect();
        const t = titleRow?.getBoundingClientRect();
        return !(l && t) || l.y + l.height <= t.top + 1;
      }),
    { timeout: 10000 },
  ).toBe(true);

  // The title stays visible within the viewport beneath the list.
  await expect.poll(
    () =>
      page.evaluate(() => {
        const titleRow = document.querySelector(
          '.app-main .flex.shrink-0.items-center.gap-2.border-b.border-line.px-3.py-2',
        ) as HTMLElement | null;
        const t = titleRow?.getBoundingClientRect();
        return !!t && t.top < window.innerHeight && t.bottom > 0;
      }),
    { timeout: 10000 },
  ).toBe(true);
});
