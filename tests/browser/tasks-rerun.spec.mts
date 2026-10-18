import { test, expect, type Page } from '@playwright/test';

/**
 * Tasks page — the Rerun control on a stopped Task.
 *
 * A stopped Task is put back on the queue by Rerun, which resets it to pending
 * without starting it. The control used to be gated on the Task's attempt count
 * as well as its status, but that count is the spent budget, which the server
 * clears every time a Task returns to pending (the queue's own retry path does
 * that). A Task stopped after such a reset therefore reads 0 attempts while
 * still holding its history as attempts — and read no Rerun button at all,
 * leaving a stopped Task with no way back onto the queue.
 */
const AT = new Date().toISOString();

function task(id: string, title: string, status = 'pending', attempts = 0): any {
  return {
    id, workspace: '/w/site', title, description: '', status,
    attempts, max_attempts: 3, created_at: AT, started_at: null,
    completed_at: null, updated_at: AT, position: 0,
  };
}

async function mockTasks(page: Page, rows: any[]) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/auth/status') return route.fulfill({ json: { authed: true, authRequired: false } });
    if (p === '/api/sessions') return route.fulfill({ json: { sessions: [], executor: 'host' } });
    if (p === '/api/models') return route.fulfill({ json: { models: [{ id: 'm', name: 'Model' }], providers: {} } });
    if (p === '/api/features/flags') return route.fulfill({ json: { subagent: { enabled: false }, understory: { enabled: false } } });
    if (/\/tasks\/[^/]+\/rerun$/.test(p)) {
      // Rerun settles the Task back to pending, clearing its spent budget.
      return route.fulfill({ json: { ...task('t0', 'Stopped task'), attempts: 0 } });
    }
    if (p.endsWith('/tasks')) {
      if (route.request().method() === 'GET') return route.fulfill({ json: rows });
      return route.fulfill({ json: rows[0] });
    }
    if (p.endsWith('/queue/status')) return route.fulfill({ json: { running: false } });
    if (p.endsWith('/attempts')) return route.fulfill({ json: [] });
    if (p.endsWith('/instructions')) return route.fulfill({ json: { text: '' } });
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('pithagoras.setup', 'done');
  });
}

// How many "Re-run task" buttons a Task's own row carries, and how many sit
// outside any row (the open Task's header row shows the same controls).
const rerunCounts = async (page: Page) =>
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('li[data-task-id]')).map((li) => ({
      id: li.getAttribute('data-task-id'),
      rerun: li.querySelectorAll('button[aria-label="Re-run task"]').length,
    }));
    const header = document.querySelectorAll('button[aria-label="Re-run task"]').length
      - rows.reduce((n, r) => n + r.rerun, 0);
    return { rows, header };
  });

test('a stopped Task offers Rerun even with its attempt budget cleared', async ({ page }) => {
  // The stopped Task reads 0 attempts, as a Task stopped after the queue reset
  // its budget honestly does.
  const rows = [
    task('t0', 'Stopped task', 'stopped', 0),
    task('t1', 'Failed task', 'failed', 2),
    task('t2', 'Pending task', 'pending', 0),
    task('t3', 'Running task', 'running', 1),
  ];
  await mockTasks(page, rows);
  await page.clock.install();
  await page.goto('/projects/Foo/tasks');

  await expect(page.locator('li[data-task-id]')).toHaveCount(4, { timeout: 10000 });

  // The stopped Task now carries the control in its row, and — as the Task the
  // workspace opens on — in the header row below the list too.
  await expect(await rerunCounts(page)).toEqual({
    rows: [{ id: 't0', rerun: 1 }, { id: 't1', rerun: 1 }, { id: 't2', rerun: 0 }, { id: 't3', rerun: 0 }],
    header: 1,
  });

  // Pressing it puts the stopped Task back on the queue: pending, with its
  // history kept as attempts rather than deleted.
  await page.locator('li[data-task-id="t0"]').getByRole('button', { name: 'Re-run task' }).click();
  await expect.poll(
    () => page.evaluate(() => {
      const li = document.querySelector('li[data-task-id="t0"]');
      return li && li.querySelector('button[aria-label="Re-run task"]') === null;
    }),
    { timeout: 10000 },
  ).toBe(true);

  // A pending or running Task still offers no Rerun: one is already on the
  // queue with nothing to reset, and the other is refused by the server.
  await expect(await rerunCounts(page)).toEqual({
    rows: [{ id: 't0', rerun: 0 }, { id: 't1', rerun: 1 }, { id: 't2', rerun: 0 }, { id: 't3', rerun: 0 }],
    header: 0,
  });
});
