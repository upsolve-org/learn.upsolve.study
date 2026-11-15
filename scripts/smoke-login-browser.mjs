/** Anonymous login hydration regression. No credentials or saved profile.
 * Set LOGIN_SMOKE_URL for a local deployment, LOGIN_SMOKE_MOBILE=1 for mobile,
 * and BROWSER_EXECUTABLE when Edge is not installed at the Windows default.
 */
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_EXECUTABLE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setViewport(process.env.LOGIN_SMOKE_MOBILE
    ? { width: 390, height: 844, isMobile: true, hasTouch: true }
    : { width: 1280, height: 900 });
  const errors = [];
  const apiRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) apiRequests.push(path);
  });
  await page.goto(process.env.LOGIN_SMOKE_URL ?? "https://learn.upsolve.study/auth/login", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  // SSR initially shows the form even in the broken build. Wait for hydration.
  await new Promise(resolve => setTimeout(resolve, 12000));
  const loginVisible = await page.evaluate(() =>
    Boolean(document.querySelector('input[name="email"]')?.getBoundingClientRect().height));
  console.log(JSON.stringify({ errors, apiRequests, loginVisible }));
  process.exitCode = errors.length || apiRequests.length || !loginVisible ? 1 : 0;
} finally {
  await browser.close();
}
