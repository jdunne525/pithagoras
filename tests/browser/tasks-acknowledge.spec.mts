import { test, expect, type Page } from '@playwright/test';

/**
 * Tasks page — acknowledging a completed Task moves it out of the Pending tab.
 *
 * Completed Tasks are kept in the Pending ("actions") view only until they are
 * acknowledged (§18): a queue-finished Task stays so its completion is seen, but
 * a Task marked complete by hand has been dealt with directly, so it should drop
 * straight into Completed. This pins that manual completion acknowledges it.
 */
const AT = new Date().toISOString();

function task(id: string, title: string, status: any = "pending"): any {
  return {
    id, workspace: "/w/site", title, description: "", status,
    attempts: 0, max_attempts: 3, created_at: AT, started_at: null,
    completed_at: null, updated_at: AT, position: 0,
  };
}

async function mockTasks(page: Page) {
  const pending = [task('t0', 'First task'), task('t1', 'Second task')];
  const completed = { ...task('t1', 'Second task', 'completed'), completed_at: AT };
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/auth/status') return route.fulfill({ json: { authed: true, authRequired: false } });
    if (p === '/api/sessions') return route.fulfill({ json: { sessions: [], executor: 'host' } });
    if (p === '/api/models') return route.fulfill({ json: { models: [{ id: 'm', name: 'Model' }], providers: {} } });
    if (p === '/api/features/flags') return route.fulfill({ json: { subagent: { enabled: false }, understory: { enabled: false } } });
    if (p.endsWith('/tasks')) {
      if (route.request().method() === 'GET') return route.fulfill({ json: pending });
      return route.fulfill({ json: pending[0] });
    }
    // The manual "Mark completed" action returns the Task finished.
    if (/\/tasks\/[^/]+\/complete$/.test(p)) return route.fulfill({ json: completed });
    if (p.endsWith('/queue/status')) return route.fulfill({ json: { running: false } });
    if (p.endsWith('/attempts')) return route.fulfill({ json: [] });
    if (p.endsWith('/instructions')) return route.fulfill({ json: { text: '' } });
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('pithagoras.setup', 'done');
  });
}

test('marking a task complete moves it out of the Pending tab', async ({ page }) => {
  await page.clock.install();
  await mockTasks(page);
  await page.goto('/projects/Foo/tasks');

  // Both tasks start in the Pending tab.
  await expect(page.locator('li[data-task-id]')).toHaveCount(2, { timeout: 10000 });

  // Finish the second task by hand.
  const row1 = page.locator('li[data-task-id="t1"]');
  await row1.getByRole('button', { name: 'Mark completed' }).click();
  await expect(row1).toBeHidden({ timeout: 10000 });

  // The completed-and-acknowledged Task leaves the Pending tab; the still-pending
  // one stays.
  await expect.poll(
    () => page.evaluate(() => document.querySelectorAll('li[data-task-id]').length),
    { timeout: 10000 },
  ).toBe(1);
  await expect(page.locator('li[data-task-id="t0"]')).toBeVisible({ timeout: 10000 });
});
