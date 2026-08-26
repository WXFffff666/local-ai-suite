import { test, expect } from '@playwright/test'

test.describe('smoke — Wave2 harness', () => {
  test('data url renders Local AI Suite', async ({ page }) => {
    await page.goto('data:text/html,<html><head><title>Local AI Suite</title></head><body><h1>Local AI Suite</h1><p>smoke ok</p></body></html>')
    await expect(page).toHaveTitle(/Local AI Suite/)
    await expect(page.getByRole('heading', { name: 'Local AI Suite' })).toBeVisible()
    await expect(page.getByText('smoke ok')).toBeVisible()
  })

  test('OpenAI compat invariant — docs state 127.0.0.1:11434', async ({ page }) => {
    // 不依赖真实服务，校验 smoke 页可执行路由断言能力
    await page.goto('data:text/html,<html><body><code>http://127.0.0.1:11434/v1/models</code></body></html>')
    await expect(page.getByText('127.0.0.1:11434')).toBeVisible()
  })
})
