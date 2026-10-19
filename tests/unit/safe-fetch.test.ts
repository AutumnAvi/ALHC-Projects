// Security review: outbound webhook / Slack posts refuse host names that resolve to private,
// loopback, link-local, or shared addresses, checked on the lookup the connection itself uses.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { isAllowedWebhookUrl } from "@/lib/integrations-shared";
import { BlockedAddressError, guardedLookup, isBlockedAddress, safePost } from "@/lib/safe-fetch";

test("private, loopback, link-local, and shared addresses are blocked", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "not-an-ip",
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("the URL check rejects shared and reserved literals", () => {
  assert.equal(isAllowedWebhookUrl("https://100.64.0.1/"), false);
  assert.equal(isAllowedWebhookUrl("https://198.18.0.1/"), false);
  assert.equal(isAllowedWebhookUrl("https://240.0.0.1/"), false);
  assert.equal(isAllowedWebhookUrl("https://hooks.slack.com/services/x"), true);
});

function fakeResolver(answers: Record<string, string[]>) {
  return (
    hostname: string,
    _options: { all: true },
    callback: (error: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void,
  ) => {
    const list = answers[hostname];
    if (!list) return callback(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), []);
    callback(null, list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  };
}

test("a lookup with any private answer is refused", async () => {
  const lookup = guardedLookup(
    fakeResolver({
      "a.169.254.169.254.nip.io": ["169.254.169.254"],
      "customer.localtest.me": ["127.0.0.1"],
      "mixed.example": ["93.184.216.34", "10.0.0.5"],
      "v6.example": ["::1"],
      "public.example": ["93.184.216.34"],
    }),
  );
  const run = (host: string, all = false) =>
    new Promise<{ error: Error | null; address: unknown }>((resolve) =>
      lookup(host, { all }, (error, address) => resolve({ error, address })),
    );
  for (const host of ["a.169.254.169.254.nip.io", "customer.localtest.me", "mixed.example", "v6.example"]) {
    const { error } = await run(host);
    assert.ok(error instanceof BlockedAddressError, host);
  }
  assert.deepEqual(await run("public.example"), { error: null, address: "93.184.216.34" });
  const all = await run("public.example", true);
  assert.equal(all.error, null);
  assert.deepEqual(all.address, [{ address: "93.184.216.34", family: 4 }]);
});

test("safePost never connects to a name that resolves to loopback", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(
      safePost(
        `https://customer.localtest.me:${port}/hook`,
        { headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 2000 },
        fakeResolver({ "customer.localtest.me": ["127.0.0.1"] }),
      ),
      BlockedAddressError,
    );
    await assert.rejects(
      safePost(`https://127.0.0.1:${port}/`, { headers: {}, body: "{}", timeoutMs: 2000 }),
      BlockedAddressError,
    );
    await assert.rejects(safePost(`http://example.com/`, { headers: {}, body: "{}", timeoutMs: 2000 }));
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});
