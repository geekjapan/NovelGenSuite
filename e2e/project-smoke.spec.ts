import { expect, test } from "@playwright/test";

test("作成した小説を九役完了後とプロジェクト再読込後に閲覧できる", async ({ page }) => {
  const prompt = "月面都市の最後の書店";

  await page.goto("/");
  await page.getByLabel("物語のプロンプト").fill(prompt);
  await page.getByRole("button", { name: "生成を開始" }).click();

  await expect(page).toHaveURL(/#\/projects\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole("button", { name: "開始/再試行" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: prompt })).toBeVisible();
  await expect(page.getByText("完了", { exact: true })).toHaveCount(9);
  await expect(page.getByRole("heading", { name: "完成した小説" })).toBeVisible();
  await expect(page.getByText("雨坂郵便局の蛍光灯は", { exact: false })).toBeVisible();

  const projectUrl = page.url();
  await page.reload();

  await expect(page).toHaveURL(projectUrl);
  await expect(page.getByRole("heading", { name: "完成した小説" })).toBeVisible();
  await expect(page.getByText("雨坂郵便局の蛍光灯は", { exact: false })).toBeVisible();
});

test("開始通信に失敗した pending プロジェクトを画面から再試行できる", async ({ page }) => {
  let runRequests = 0;
  await page.route("**/projects/*/run", (route) => {
    runRequests += 1;
    return runRequests === 1 ? route.abort("failed") : route.continue();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "生成を開始" }).click();

  await expect(page).toHaveURL(/#\/projects\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole("button", { name: "開始/再試行" })).toBeVisible();
  await page.getByRole("button", { name: "開始/再試行" }).click();

  await expect(page.getByText("完了", { exact: true })).toHaveCount(9);
  expect(runRequests).toBe(2);
});

test("承認ゲートと expand/revise 操作へ GUI から到達できる", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("章構成を確認してから執筆する").check();
  await page.getByLabel("章数").fill("1");
  await page.getByLabel("一章の文字数").fill("100");
  await page.getByRole("button", { name: "生成を開始" }).click();

  await expect(page.getByRole("heading", { name: "章構成を確認" })).toBeVisible();
  await page.getByLabel("題名").fill("人が決めた章題");
  await page.getByRole("button", { name: "章構成を承認して再開" }).click();

  await expect(page.getByRole("heading", { name: "完成した小説" })).toBeVisible();
  await expect(page.getByRole("button", { name: "章を拡張" })).toBeVisible();
  await expect(page.getByRole("button", { name: "章を改稿" })).toBeVisible();

  const expanded = page.waitForResponse((response) =>
    response.url().endsWith("/run") && response.request().postData()?.includes('"operation":"expand"') === true);
  await page.getByRole("button", { name: "章を拡張" }).click();
  await expanded;

  const revised = page.waitForResponse((response) =>
    response.url().endsWith("/run") && response.request().postData()?.includes('"operation":"revise"') === true);
  await page.getByRole("button", { name: "章を改稿" }).click();
  await revised;

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("計画の改稿指示").fill("中盤の緊張感を高める");
  const planRevised = page.waitForResponse((response) =>
    response.url().endsWith("/plan/revise") && response.request().method() === "POST");
  await page.getByRole("button", { name: "計画を改稿" }).click();
  await planRevised;
  await expect(page.getByRole("heading", { name: "章構成を確認" })).toBeVisible();
  await page.getByRole("button", { name: "章構成を承認して再開" }).click();
  await expect(page.getByRole("heading", { name: "完成した小説" })).toBeVisible();
});
