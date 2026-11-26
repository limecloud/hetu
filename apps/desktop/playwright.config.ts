import {defineConfig} from "@playwright/test";
export default defineConfig({testDir:"tests",testMatch:"**/*.spec.ts",workers:1,timeout:90000,reporter:process.env.CI?[["list"],["github"]]:"list",use:{trace:"retain-on-failure"},outputDir:"test-results"});
