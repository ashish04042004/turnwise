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

test('each centre signs in its own staff, and a manager tunes its settings', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Centre').selectOption({ label: 'Bandra West Imaging & Labs · Mumbai' });
  await expect(page.getByText(/Neha Shah \(manager\) 5555/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Asha Menon/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Neha Shah/ }).click();
  await page.getByLabel('PIN for Neha Shah').fill('5555');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.centre')).toContainText('Bandra West Imaging & Labs');

  // Priority choices are this centre's own.
  await page.getByRole('link', { name: 'Book & walk-in' }).click();
  await expect(page.getByRole('option', { name: 'Same-day report' })).toHaveCount(1);

  await page.getByRole('link', { name: 'Settings' }).click();
  const row = page.locator('tr', { hasText: 'Slot search options' });
  await row.getByRole('spinbutton').fill('99');
  await expect(row.getByText('At most 20')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Save' })).toBeDisabled();
  await row.getByRole('spinbutton').fill('4');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Slot search options saved' })).toBeVisible();
  await row.getByRole('button', { name: 'Use default' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'back to the default' })).toBeVisible();
  await expect(row.getByRole('spinbutton')).toHaveValue('5');

  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByText(/Setting slot_search_options reset to default/).first()).toBeVisible();
});

test('a manager adds a machine and a service, front desk can book it, and retiring it withdraws it', async ({ page }) => {
  const tag = Date.now().toString(36).toUpperCase();
  const toast = (text) => expect(page.locator('.toast').filter({ hasText: text })).toBeVisible();
  await signIn(page, 'Asha Menon', '1234');
  await page.getByRole('link', { name: 'Catalogue' }).click();

  await page.getByRole('button', { name: 'Capabilities', exact: true }).click();
  await page.getByLabel('New capability').fill(`Densitometry ${tag}`);
  await page.getByLabel('Code (permanent)').fill(`dexa_${tag}`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await toast(`Densitometry ${tag} added`);

  await page.getByRole('button', { name: 'Resources', exact: true }).click();
  const addResource = page.locator('section.panel').first();
  await addResource.getByLabel('Name', { exact: true }).fill(`DEXA ${tag}`);
  await addResource.getByLabel('Add capability').selectOption(`dexa_${tag}`);
  await addResource.getByRole('button', { name: 'Add resource' }).click();
  await toast(`DEXA ${tag} added`);

  await page.getByRole('button', { name: 'Services', exact: true }).click();
  const addService = page.locator('section.panel').first();
  await addService.getByLabel('Name', { exact: true }).fill(`Bone density ${tag}`);
  await addService.locator('label', { hasText: /^Category/ }).locator('select').selectOption({ index: 1 });
  await addService.getByLabel('Duration (min)', { exact: true }).fill('20');
  await addService.getByLabel('Add capability').selectOption(`dexa_${tag}`);
  await addService.getByLabel('Code (short, permanent)').fill(`BD_${tag}`);
  await addService.getByRole('button', { name: 'Add service' }).click();
  await toast(`Bone density ${tag} added`);

  await page.getByRole('link', { name: 'Book & walk-in' }).click();
  await expect(page.locator('label.svc', { hasText: `BD_${tag}` })).toBeVisible();

  await page.getByRole('link', { name: 'Catalogue' }).click();
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('row', { name: new RegExp(`BD_${tag}`) }).getByRole('button', { name: 'Retire' }).click();
  await toast(`Bone density ${tag} retired`);
  await page.getByRole('link', { name: 'Book & walk-in' }).click();
  await expect(page.locator('label.svc', { hasText: `BD_${tag}` })).toHaveCount(0);
});
