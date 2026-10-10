/**
 * Browser smoke test of the main loop across two roles, against the seeded
 * demo centre: front desk registers a walk-in, a technician starts and
 * completes the service from the live queue.
 */
import { expect, test } from '@playwright/test';

async function signIn(page, name, pin) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByLabel(`PIN for ${name}`).fill(pin);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.whoami')).toContainText(name);
}

async function signOut(page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Who’s signing in?' })).toBeVisible();
}

test('a walk-in goes from the front desk to done', async ({ page }) => {
  const patient = `Smoke Test ${Date.now() % 100_000}`;
  // Starting early may need a confirmation when another booking has to move.
  page.on('dialog', (dialog) => dialog.accept());

  await signIn(page, 'Ravi Kumar', '1111');
  await page.getByRole('link', { name: 'Book & walk-in' }).click();
  await page.getByPlaceholder('e.g. Rohan Verma').fill(patient);
  await page.locator('label.svc', { hasText: 'XRAY_CHEST' }).click();
  await page.getByRole('button', { name: 'Place in queue' }).click();
  await expect(page.getByRole('heading', { name: `${patient} is in the queue` })).toBeVisible();

  // Front desk can see the queue but not run services.
  await page.getByRole('link', { name: 'Floor' }).click();
  const deskCard = page.locator('article.visit', { hasText: patient });
  await expect(deskCard).toBeVisible();
  await expect(deskCard.getByRole('button', { name: 'Start' })).toHaveCount(0);
  await signOut(page);

  await signIn(page, 'Farah Khan', '2222');
  await expect(page.getByRole('link', { name: 'Book & walk-in' })).toHaveCount(0);
  // The seeded day may have someone in the X-ray room right now; finish them first.
  const board = await (await page.request.get('/api/board')).json();
  for (const step of board.visits.flatMap((v) => v.steps)) {
    if (step.serviceCode === 'XRAY_CHEST' && step.status === 'in_service') {
      expect((await page.request.post(`/api/steps/${step.id}/complete`, { data: {} })).ok()).toBe(true);
    }
  }
  const card = page.locator('article.visit', { hasText: patient });
  await card.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'XRAY_CHEST started' })).toBeVisible();
  await expect(card.locator('.status')).toHaveText('In service');

  await card.getByRole('button', { name: 'Complete' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'XRAY_CHEST completed' })).toBeVisible();
  // Finished visits leave "On the floor" for "Done".
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.locator('article.visit', { hasText: patient }).locator('.status')).toHaveText('Completed');
});

test('a wrong PIN is refused and pages respect roles', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Farah Khan/ }).click();
  await page.getByLabel('PIN for Farah Khan').fill('0000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('That PIN is not right')).toBeVisible();

  await signIn(page, 'Farah Khan', '2222');
  await page.goto('/staff');
  await expect(page.getByRole('heading', { name: 'Managers only' })).toBeVisible();
  await signOut(page);

  await signIn(page, 'Asha Menon', '1234');
  await page.getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('cell', { name: /Asha Menon/ })).toBeVisible();
});
