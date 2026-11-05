import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

// Outbound POSTs to URLs people typed (Slack and webhook rule actions). A URL check alone can't stop a
// host name that resolves to a private address (a.169.254.169.254.nip.io, *.localtest.me), so the
// connection's own DNS lookup refuses loopback, private, link-local, shared (100.64.0.0/10), and other
// non-public answers. The address checked is the address connected to, so a second lookup (DNS
// rebinding) can't swap it. Redirects are never followed, and the whole request has a time limit.

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // shared address space (CGNAT)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

// IPv6 forms that carry an IPv4 address: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64
// (64:ff9b::/96), and 6to4 (2002:AABB:CCDD::/48). The embedded address is checked as IPv4.
function embeddedIpv4(ip: string): string | null {
  const groups = expandIpv6(ip);
  if (!groups) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  if (zeros(0, 5) && (groups[5] === 0xffff || groups[5] === 0)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  return null;
}

function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1].split(".").map(Number);
    text = text.slice(0, -dotted[1].length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  const all = [...left, ...Array(Math.max(fill, 0)).fill("0"), ...right];
  if (all.length !== 8) return null;
  const groups = all.map((g) => parseInt(g, 16));
  return groups.some((g) => Number.isNaN(g)) ? null : groups;
}

// True when an address must never be connected to. Anything that isn't a valid IP counts as blocked.
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, "ipv4");
  if (family === 6) {
    if (BLOCKED.check(ip, "ipv6")) return true;
    const v4 = embeddedIpv4(ip);
    return v4 !== null && BLOCKED.check(v4, "ipv4");
  }
  return true;
}

export class BlockedAddressError extends Error {
  constructor() {
    super("The webhook host resolves to a private or local address");
    this.name = "BlockedAddressError";
  }
}

type LookupFn = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

// A dns.lookup replacement for the connection: every answer must be public, or none is used.
export function guardedLookup(resolve: LookupFn = dnsLookup as unknown as LookupFn) {
  return (
    hostname: string,
    options: { all?: boolean } | number,
    callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) {
        return callback(new BlockedAddressError(), []);
      }
      if (typeof options === "object" && options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export type SafePostResult = { status: number; ok: boolean; body: string };

// POST a body to a public https:// URL. Never follows redirects (a 3xx comes back as the answer).
export function safePost(
  url: string,
  init: { headers: Record<string, string>; body: string; timeoutMs: number; maxBodyBytes?: number },
  resolve?: LookupFn,
): Promise<SafePostResult> {
  const target = new URL(url);
  if (target.protocol !== "https:") return Promise.reject(new Error("Only https:// targets are allowed"));
  const host = target.hostname.replace(/^\[|\]$/g, "");
  // Node skips the lookup for IP literals, so check those here.
  if (isIP(host) && isBlockedAddress(host)) return Promise.reject(new BlockedAddressError());
  const maxBytes = init.maxBodyBytes ?? 4096;
  return new Promise((resolvePromise, reject) => {
    const req = request(
      target,
      {
        method: "POST",
        headers: { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) },
        lookup: guardedLookup(resolve) as never,
        agent: false,
        timeout: init.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size < maxBytes) chunks.push(chunk.subarray(0, maxBytes - size));
          size += chunk.length;
          if (size >= maxBytes) res.destroy();
        });
        const finish = () => {
          clearTimeout(timer);
          const status = res.statusCode ?? 0;
          resolvePromise({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks).toString("utf8") });
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      },
    );
    const timer = setTimeout(() => {
      const e = new Error("The request timed out");
      e.name = "TimeoutError";
      req.destroy(e);
    }, init.timeoutMs);
    req.on("timeout", () => {
      const e = new Error("The request timed out");
      e.name = "TimeoutError";
      req.destroy(e);
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(init.body);
  });
}

export type SafeDownloadResult =
  | { ok: true; status: number; bytes: Buffer; contentType: string | null }
  | { ok: false; status: number; tooLarge: boolean };

// GET a public https:// file (the Asana importer's attachment downloads). Every connection uses the
// guarded lookup (no private or local addresses, so no DNS rebinding); redirects are followed by hand,
// at most `maxRedirects`, each hop https-only and checked the same way. Stops reading past `maxBytes`
// (tooLarge) instead of buffering a huge file. Sends no credentials or cookies.
export async function safeDownload(
  url: string,
  init: { timeoutMs: number; maxBytes: number; maxRedirects?: number },
  resolve?: LookupFn,
): Promise<SafeDownloadResult> {
  let current = url;
  for (let hop = 0; hop <= (init.maxRedirects ?? 3); hop++) {
    const result = await getOnce(current, init, resolve);
    if ("location" in result) {
      current = new URL(result.location, current).toString();
      continue;
    }
    return result;
  }
  return { ok: false, status: 310, tooLarge: false };
}

function getOnce(
  url: string,
  init: { timeoutMs: number; maxBytes: number },
  resolve?: LookupFn,
): Promise<SafeDownloadResult | { location: string }> {
  const target = new URL(url);
  if (target.protocol !== "https:") return Promise.reject(new Error("Only https:// downloads are allowed"));
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host)) return Promise.reject(new BlockedAddressError());
  return new Promise((resolvePromise, reject) => {
    const req = request(
      target,
      { method: "GET", lookup: guardedLookup(resolve) as never, agent: false, timeout: init.timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string") {
          clearTimeout(timer);
          res.resume();
          return resolvePromise({ location });
        }
        if (status < 200 || status >= 300) {
          clearTimeout(timer);
          res.resume();
          return resolvePromise({ ok: false, status, tooLarge: false });
        }
        if (Number(res.headers["content-length"] ?? "0") > init.maxBytes) {
          clearTimeout(timer);
          res.destroy();
          return resolvePromise({ ok: false, status, tooLarge: true });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > init.maxBytes) {
            done = true;
            clearTimeout(timer);
            res.destroy();
            resolvePromise({ ok: false, status, tooLarge: true });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (done) return;
          clearTimeout(timer);
          const type = res.headers["content-type"];
          resolvePromise({
            ok: true,
            status,
            bytes: Buffer.concat(chunks),
            contentType: typeof type === "string" ? type.split(";")[0].trim().slice(0, 255) || null : null,
          });
        });
        res.on("error", (error) => {
          if (done) return;
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    const timer = setTimeout(() => {
      const e = new Error("The request timed out");
      e.name = "TimeoutError";
      req.destroy(e);
    }, init.timeoutMs);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}
