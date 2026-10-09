import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("purchase reader parses a valid provider response in the TypeScript development runtime", () => {
  const register = require.resolve("ts-node/register/transpile-only", { paths: [path.dirname(require.resolve("ts-node-dev"))] });
  const child = spawnSync(process.execPath, ["-r", register, "-e", `
    const assert = require('node:assert/strict');
    const { readPurchaseBill } = require('./src/modules/inventory/purchaseReview');
    const observations = { supplierName: 'Owned supplier', billNumber: 'DEV-1', billDate: null, payable: '20.00', lines: [{ name: 'Rice', code: null, unit: 'BOX', quantity: '2', cost: '10' }] };
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
      assert.equal(init.headers['x-goog-api-key'], 'test-only-no-live-provider');
      const input = JSON.parse(init.body);
      assert.equal(input.contents[0].parts[1].inline_data.mime_type, 'image/png');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '\\x60\\x60\\x60json\\n' + JSON.stringify(observations) + '\\n\\x60\\x60\\x60' }] } }] }));
    };
    readPurchaseBill(Buffer.from('owned-source'), 'image/png').then(result => {
      assert.deepEqual(result.observations, observations);
      assert.equal(calls, 1);
      console.log('development provider-success branch passed');
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, "../.."), env: { ...process.env, GEMINI_API_KEY: "test-only-no-live-provider" }, encoding: "utf8", timeout: 30_000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /development provider-success branch passed/);
});
