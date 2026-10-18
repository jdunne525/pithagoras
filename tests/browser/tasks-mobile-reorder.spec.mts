import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Reordering Tasks by dragging, on a phone (touch) and on a desktop (mouse).
 *
 * A phone has no native `draggable`, so the grip beside a row is followed by
 * hand: the grip carries `touch-action: none`, which is what keeps a phone's
 * browser from taking the press into a pan of the list — without it no pointer
 * move ever arrives and the reorder never fires — and the pointer is captured
 * the moment the press lands (see followPointer). The rest of the row is left
 * to the browser, so a tap still opens a task and a swipe still scrolls the
 * list. A desktop mouse keeps driving the native `draggable`. Both paths drop
 * into the same anchor primitive, so they agree about where a row lands.
 * This pins all of it.
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

const orderOf = async (page: Page) =>
  await page.evaluate(() =>
    Array.from(document.querySelectorAll("li[data-task-id]")).map((el) => el.getAttribute("data-task-id")),
  );

const gripBox = async (page: Page, n: number) =>
  await page.evaluate((n) => {
    const grips = document.querySelectorAll('li[data-task-id] button[aria-label="Drag to reorder"]');
    const r = grips[n].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, n);

// What a finger does on a phone: press, hold, move, let go. Events are
// dispatched from within the grip itself so they attach exactly where React
// listens (by delegation) and bubble up to the window.
async function touchDrag(page: Page, n: number, toX: number, toY: number, steps = 8, mid?: () => Promise<void>) {
  const from = await gripBox(page, n);
  const emit = async (type: string, x: number, y: number) => {
    await page.evaluate(({ n, type, x, y }) => {
      const grips = document.querySelectorAll('li[data-task-id] button[aria-label="Drag to reorder"]');
      (grips[n] as HTMLElement).dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1,
        pointerType: "touch", clientX: x, clientY: y,
      }));
    }, { n, type, x, y });
  };
  await emit("pointerdown", from.x, from.y);
  await page.waitForTimeout(150);
  for (let i = 1; i <= steps; i++) {
    await emit("pointermove", from.x + (toX - from.x) * (i / steps), from.y + (toY - from.y) * (i / steps));
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(20);
  await mid?.();
  await page.waitForTimeout(20);
  await emit("pointerup", toX, toY);
}

// A press on the body of a row that the browser turns into a pan of the list:
// it fires pointerdown and then takes the pointer over, so nothing of the
// gesture is ours to hear.
async function touchPan(page: Page, n: number, toY: number) {
  const from = await gripBox(page, n);
  await page.evaluate(({ n, x, y }) => {
    const rows = document.querySelectorAll("li[data-task-id]");
    (rows[n] as HTMLElement).dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerId: 2, pointerType: "touch", clientX: x, clientY: y,
    }));
  }, { n, x: from.x + 120, y: from.y });
  await page.waitForTimeout(150);
  await page.evaluate(({ n, y }) => {
    const rows = document.querySelectorAll("li[data-task-id]");
    (rows[n] as HTMLElement).dispatchEvent(new PointerEvent("pointercancel", {
      bubbles: true, cancelable: true, pointerId: 2, pointerType: "touch", clientX: 0, clientY: y,
    }));
  }, { n, y: toY });
}

test('phone: the grip beside a row carries touch-action none', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockTasks(page, ["t0", "t1", "t2"]);
  await page.goto("/projects/Foo/tasks");
  await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

  // Without this the browser answers a press on the grip with a scroll of the
  // list, and the reorder never gets a single move to follow.
  await expect(
    await page.evaluate(() => {
      const grip = document.querySelector('li[data-task-id] button[aria-label="Drag to reorder"]');
      return !!grip && getComputedStyle(grip).touchAction;
    }),
  ).toBe("none");
});

test('phone: dragging a task grip down its list reorders and persists', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await mockTasks(page, ["t0", "t1", "t2"]);
  await page.goto("/projects/Foo/tasks");
  await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

  const last = await page.evaluate(() => {
    const rows = document.querySelectorAll("li[data-task-id]");
    const r = (rows[rows.length - 1] as HTMLElement).getBoundingClientRect();
    return { x: r.x + 40, y: r.top + r.height * 0.75 };
  });

  // Grab the top row's grip and carry it below the middle of the last row.
  await touchDrag(page, 0, last.x, last.y);

  await expect.poll(() => orderOf(page), { timeout: 5000 }).toEqual(["t1", "t2", "t0"]);
  expect(await mock.getLastOrder()).toEqual(["t1", "t2", "t0"]);
});

test('phone: a line shows where the carried row will go, under the finger', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockTasks(page, ["t0", "t1", "t2"]);
  await page.goto("/projects/Foo/tasks");
  await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

  const last = await page.evaluate(() => {
    const rows = document.querySelectorAll("li[data-task-id]");
    const r = (rows[rows.length - 1] as HTMLElement).getBoundingClientRect();
    return { x: r.x + 40, y: r.top + r.height * 0.75 };
  });

  // The finger hides the rows it carries a task through, so while it is still
  // held the row beside draws a line where the carried row would land.
  let lines = 0;
  await touchDrag(page, 0, last.x, last.y, 8, async () => {
    lines = Math.max(lines, await page.evaluate(() => document.querySelectorAll("div.task-drop").length));
  });
  expect(lines).toBe(1);

  // And the line is gone once the finger lets go and the row has moved.
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("div.task-drop").length)).toBe(0);
  await expect(await orderOf(page)).toEqual(["t1", "t2", "t0"]);
});

test('phone: a tap on the grip opens nothing and moves nothing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await mockTasks(page, ["t0", "t1", "t2"]);
  await page.goto("/projects/Foo/tasks");
  await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

  const from = await gripBox(page, 1);
  await touchDrag(page, 1, from.x + 3, from.y + 3, 2);

  // A press that never carried far enough is no drag at all.
  await expect(await orderOf(page)).toEqual(["t0", "t1", "t2"]);
  expect(await mock.getLastOrder()).toBe(null);
});

test('phone: the browser still scrolls the list past a row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await mockTasks(page, ["t0", "t1", "t2"]);
  await page.goto("/projects/Foo/tasks");
  await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

  // A press on the body of a row, taken over by the browser as a pan, is left
  // alone: it reorders nothing.
  await touchPan(page, 0, 400);
  await expect(await orderOf(page)).toEqual(["t0", "t1", "t2"]);
  expect(await mock.getLastOrder()).toBe(null);
});

test('desktop: dragging a task row with a mouse reorders and persists', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mock = await mockTasks(page, ["t0", "t1", "t2"]);
  await page.goto("/projects/Foo/tasks");
  await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

  const rows = page.locator("li[data-task-id]");
  const bottom = await rows.nth(2).boundingBox();
  const top = await rows.nth(0).boundingBox();

  // Drag the last row onto the lower half of the first one: it lands after it.
  await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2);
  await page.mouse.down();
  await page.mouse.move(top.x + top.width / 2, top.y + top.height * 0.75, { steps: 10 });
  await page.mouse.up();

  await expect.poll(() => orderOf(page), { timeout: 5000 }).toEqual(["t0", "t2", "t1"]);
  expect(await mock.getLastOrder()).toEqual(["t0", "t2", "t1"]);
});

test.describe("on a phone, as the browser of one really sees it", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  // A phone reports no hover and a coarse pointer, which is what makes the grip
  // a thumb-wide strip you can see: on a desktop it stays invisible until the
  // cursor comes near it, and there it is only as wide as its icon.
  test("the grip is a visible, thumb-wide strip that the browser will not pan", async ({ page }) => {
    await mockTasks(page, ["t0", "t1", "t2"]);
    await page.goto("/projects/Foo/tasks");
    await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

    const box = await page.evaluate(() => {
      const grip = document.querySelector('li[data-task-id] button[aria-label="Drag to reorder"]');
      const row = grip ? grip.closest("li[data-task-id]") : null;
      const g = grip ? grip.getBoundingClientRect() : null;
      const r = row ? row.getBoundingClientRect() : null;
      return {
        touchAction: grip ? getComputedStyle(grip).touchAction : "",
        opacity: grip ? getComputedStyle(grip).opacity : "",
        w: g ? g.width : 0,
        h: g ? g.height : 0,
        rowH: r ? r.height : 0,
      };
    });
    expect(box.touchAction).toBe("none");
    expect(box.opacity).toBe("1");
    expect(box.w).toBeGreaterThanOrEqual(28);
    // The grip reaches the row's own edges, past its padding: only its borders
    // are left over, so a finger may land anywhere along the row's height.
    expect(box.h).toBeGreaterThanOrEqual(box.rowH - 4);
  });

  // What a real finger does: the browser's own touch pipeline, not events fired
  // at the page. Chromium answers a press on the grip with moves — its touch
  // action is none, so the list is never panned — and the row follows them to
  // the slot it lets go in. This is the phone the user has, end to end.
  test("a real finger drag on the grip reorders and persists", async ({ page }) => {
    const mock = await mockTasks(page, ["t0", "t1", "t2"]);
    await page.goto("/projects/Foo/tasks");
    await expect(page.locator("li[data-task-id]")).toHaveCount(3, { timeout: 10000 });

    const from = await page.evaluate(() => {
      const grips = document.querySelectorAll('li[data-task-id] button[aria-label="Drag to reorder"]');
      const r = (grips[0] as HTMLElement).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const to = await page.evaluate(() => {
      const rows = document.querySelectorAll("li[data-task-id]");
      const r = (rows[rows.length - 1] as HTMLElement).getBoundingClientRect();
      return { x: r.x + 40, y: r.top + r.height * 0.75 };
    });

    const client = await page.context().newCDPSession(page);
    const touch = async (type: string, x: number, y: number) => {
      await client.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x, y }] });
    };
    await touch("touchStart", from.x, from.y);
    await page.waitForTimeout(150);
    for (let i = 1; i <= 10; i++) {
      await touch("touchMove", from.x + (to.x - from.x) * (i / 10), from.y + (to.y - from.y) * (i / 10));
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(60);
    await touch("touchEnd", to.x, to.y);

    await expect.poll(() => orderOf(page), { timeout: 5000 }).toEqual(["t1", "t2", "t0"]);
    expect(await mock.getLastOrder()).toEqual(["t1", "t2", "t0"]);
  });
});
