import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
export default defineConfig({ ...base, webServer: undefined, use: { reuseExistingServer: true } });
