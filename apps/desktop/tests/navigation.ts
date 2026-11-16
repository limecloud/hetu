import { expect, type Page } from "@playwright/test";

/** 窄窗口会自动收起目录，沿作者可见的入口重新打开。 */
export async function openDirectory(page: Page) {
  const toggle = page.getByRole("button", { name: "卷章目录", exact: true });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await expect(page.getByRole("navigation", { name: "文稿目录", exact: true })).toBeVisible();
}

/** 沿作者可见的项目导航展开分组，不通过内部桥接代替导航。 */
export async function navigate(page: Page, label: string) {
  const navigation = page.getByRole("complementary", { name: "项目导航", exact: true });
  const groups: Record<string, string> = {
    "作品设定": "创作资料", "图片成果": "创作资料", "资料与素材": "创作资料", "素材与线索": "创作资料",
    "文稿版本": "版本与交付", "原稿导入": "版本与交付", "作品交付": "版本与交付",
    "管理方案": "检查工具", "Agent 协作": "检查工具", "创作插件": "检查工具", "参考浏览器": "检查工具",
  };
  if (groups[label]) {
    const group = navigation.locator("details.navigation-group").filter({ has: page.locator("summary", { hasText: groups[label] }) });
    if (!(await group.evaluate((element) => (element as HTMLDetailsElement).open))) await group.locator("summary").click();
  }
  await navigation.getByRole("button", { name: label, exact: true }).click();
}

export async function documentAction(page: Page, label: string) {
  const menu = page.locator("details").filter({ has: page.locator('summary[aria-label="文稿操作"]') });
  if (!(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await menu.locator("summary").click();
  await menu.getByRole("button", { name: label, exact: true }).click();
}
