import { expect, test } from "@playwright/test";

test("作成した小説を九役完了後とプロジェクト再読込後に閲覧できる", async ({ page }) => {
  const prompt = "月面都市の最後の書店";

  await page.goto("/");
  await page.getByLabel("物語のプロンプト").fill(prompt);
  await page.getByRole("button", { name: "生成を開始" }).click();

  await expect(page).toHaveURL(/#\/projects\/[A-Za-z0-9_-]+$/);
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
