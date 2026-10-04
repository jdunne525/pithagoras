import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Mobile (touch) drag-to-reorder of Tasks in the workspace. On phones the
 * native `draggable` attribute never fires, so the grip must follow the pointer
 * by hand and call setTaskOrder. This pins that behaviour.
 */
const AT = new Date().toISOString();

function task(id: string, title: string, position: number) {
  return {
    id, workspace: "/w/site", title, description: "", status: "pending",
    attempts: 0, max_attempts: 3, created_at: AT, started_at: null,
    completed_at: null, updated_at: AT, position,
  };
}

async function mockTasks(page: Page, order: string[]) {
  const tasks = order.map((id, i) => task(id, `Task ${id}`, i));
  let lastOrder: any = null;
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/auth/status") return route.fulfill({ json: { authed: true, authRequired: false } });
    if (p === "/api/sessions") return route.fulfill({ json: { sessions: [], executor: "host" } });
    if (p === "/api/models") return route.fulfill({ json: { models: [{ id: "m", name: "Model" }], providers: {} } });
    if (p === "/api/features/flags") return route.fulfill({ json: { subagent: { enabled: false }, understory: { enabled: false } } });
    if (p.endsWith("/tasks") || p.endsWith("/tasks/order")) {
      if (route.request().method() === "GET") return route.fulfill({ json: tasks });
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        lastOrder = body.order ?? body.ids;
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: tasks[0] });
    }
    if (p.endsWith("/queue/status")) return route.fulfill({ json: { running: false } });
    if (p.endsWith("/attempts")) return route.fulfill({ json: [] });
    if (p.endsWith("/instructions")) return route.fulfill({ json: { text: "" } });
    return route.continue();
  });
  await page.addInitScript(() => { localStorage.setItem("pithagoras.setup", "done"); });
  return { getLastOrder: () => lastOrder };
}

// Dispatch a hand-followed touch drag (pointerdown -> moves -> pointerup) on a
// target element, emulating what a finger does on a phone. Events are dispatched
// from within the element itself (as `this`) so they attach exactly where React
// listens, and bubble up to the window-level listener.
async function touchDrag(page: Page, grip: Locator, toX: number, toY: number, steps = 8) {
  await grip.evaluate((el, args) => {
    const { toX, toY, steps } = args;
    const pid = 1;
    const b = el.getBoundingClientRect();
    const sx = b.left + b.width / 2;
    const sy = b.top + b.height / 2;
    const evt = (type: string, x: number, y: number) => {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: pid,
        pointerType: "touch", clientX: x, clientY: y,
      }));
    };
    evt("pointerdown", sx, sy);
    for (let i = 1; i <= steps; i++) {
      evt("pointermove", sx + (toX - sx) * (i / steps), sy + (toY - sy) * (i / steps));
    }
    evt("pointerup", toX, toY);
  }, { toX, toY, steps });
}

test('phone: dragging a task grip upward reorders and persists', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await mockTasks(page, ["t0", "t1", "t2"]);
  await page.goto("/projects/Foo/tasks");

  await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

  const grips = page.locator("li[data-task-id] button[aria-label=\"Drag to reorder\"]");
  await expect(grips).toHaveCount(3);

  // Grab the bottom row (t2) grip and drag it up to near the top of the list.
  const box = await page.evaluate(() => {
    const ul = document.querySelector("ul") as HTMLElement;
    const r = ul.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + 5 };
  });
  await touchDrag(
    page,
    page.locator("li[data-task-id] button[aria-label=\"Drag to reorder\"]").nth(2),
    box.x,
    box.y,
  );

  // After the drag, the bottom row (t2) moved up one slot, ahead of t1.
  await expect.poll(async () =>
    page.locator("li[data-task-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-task-id"))),
  ).toEqual(["t0", "t2", "t1"]);

  // And the new order was persisted via PUT /tasks/order.
  expect(await mock.getLastOrder()).toEqual(["t0", "t2", "t1"]);
});
