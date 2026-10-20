import { randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as http from "node:http";
import * as tls from "node:tls";
import type { ClientIdentity } from "./types.js";

export function checkKeyFilePermissions(keyPath: string): void {
  if (!existsSync(keyPath)) throw new Error(`TLS key file not found: ${keyPath}`);
  if (process.platform !== "win32") {
    const mode = statSync(keyPath).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`TLS private key file permissions are too broad: ${keyPath}`);
  }
}

export function computeCertFingerprint(certPath: string): string | undefined {
  try {
    const pem = readFileSync(path.resolve(certPath), "utf-8");
    const cert = new X509Certificate(pem);
    return cert.fingerprint256.toUpperCase();
  } catch {
    return undefined;
  }
}


export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}


export function readProtectedToken(tokenFile: string): string {
  if (!existsSync(tokenFile)) {
    mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("hex");
    writeFileSync(tokenFile, `${token}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    return token;
  }
  if (process.platform !== "win32") {
    const mode = statSync(tokenFile).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`Token file permissions are too broad: ${tokenFile}`);
  }
  const token = readFileSync(tokenFile, "utf-8").trim();
  if (token.length < 32 || token.length > 256) throw new Error(`Invalid daemon token file: ${tokenFile}`);
  return token;
}

export function sameToken(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function extractClientIdentity(req: http.IncomingMessage): ClientIdentity {
  const socket = req.socket;
  if ("getPeerCertificate" in socket && typeof (socket as tls.TLSSocket).getPeerCertificate === "function") {
    const peer = (socket as tls.TLSSocket).getPeerCertificate();
    if (peer && Object.keys(peer).length > 0) {
      const rawFp = peer.fingerprint256 || "";
      const fingerprint256 = rawFp ? rawFp.toUpperCase() : undefined;
      const rawCn = peer.subject?.CN;
      const subjectCn = Array.isArray(rawCn) ? rawCn[0] : rawCn;
      return { fingerprint256, subjectCn };
    }
  }
  return {};
}
