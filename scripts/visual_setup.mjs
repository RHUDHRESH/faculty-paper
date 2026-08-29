// Drives the first-run setup wizard on a scratch instance (:8301) exactly as
// a new college would: fill the college name, create the founder, land on a
// sign-in screen that carries the new college's name. Screenshots land in
// gui-test-screenshots/ alongside the rest of the visual evidence.
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const BASE = "http://localhost:5175";
const OUT = "../gui-test-screenshots";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const shot = async (name) => writeFile(`${OUT}/${name}.png`, await page.screenshot({ fullPage: true }));

// step 1: the college
await page.goto(BASE + "/setup", { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
await page.getByLabel("College name").fill("Saveetha Engineering College");
await shot("t40_setup_college");
await page.getByRole("button", { name: "Continue" }).click();
await page.waitForTimeout(300);

// step 2: the founder
await shot("t41_setup_admin");
await page.getByLabel("Administrator name").fill("Ada Founder");
await page.getByLabel("Administrator email").fill("office@saveetha.ac.in");
await page.getByLabel("Administrator password").fill("founders-gate-2026");
await page.getByLabel("Type the password again").fill("founders-gate-2026");
await shot("t42_setup_admin_filled");
await page.getByRole("button", { name: "Continue" }).click();
await page.waitForTimeout(300);

// step 3: confirm and create
await shot("t43_setup_confirm");
await page.getByRole("button", { name: "Create the system" }).click();
await page.waitForSelector("text=is set up", { timeout: 10000 });
await shot("t44_setup_done");

// the sign-in screen now belongs to the new college
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(600);
await shot("t45_signin_new_college");
const signInName = await page.locator("p.text-fg-muted").first().textContent();

// and the door is closed
const status = await (await fetch(BASE + "/api/setup/status")).json();
const institution = await (await fetch(BASE + "/api/institution")).json();

console.log(JSON.stringify({ signInName, status, institution }, null, 2));
await browser.close();
