import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TestTlsBundle {
  readonly dir: string;
  readonly caKey: string;
  readonly caCert: string;
  readonly untrustedCaKey: string;
  readonly untrustedCaCert: string;
  readonly serverKey: string;
  readonly serverCert: string;
  readonly serverWrongHostKey: string;
  readonly serverWrongHostCert: string;
  readonly worker1Key: string;
  readonly worker1Cert: string;
  readonly worker2Key: string;
  readonly worker2Cert: string;
  readonly workerUntrustedKey: string;
  readonly workerUntrustedCert: string;
  readonly rotatedServerKey: string;
  readonly rotatedServerCert: string;
  readonly rotatedWorker1Key: string;
  readonly rotatedWorker1Cert: string;
}

export function generateTestTlsBundle(dir: string): TestTlsBundle {
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  function createCa(name: string): { key: string; cert: string } {
    const key = path.join(dir, `${name}.key`);
    const cert = path.join(dir, `${name}.crt`);
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1",
      "-subj", `/CN=${name}`,
    ], { stdio: "pipe" });
    return { key, cert };
  }

  function createSignedCert(
    name: string,
    caKey: string,
    caCert: string,
    commonName: string,
    san?: string
  ): { key: string; cert: string } {
    const key = path.join(dir, `${name}.key`);
    const csr = path.join(dir, `${name}.csr`);
    const cert = path.join(dir, `${name}.crt`);
    execFileSync("openssl", [
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", csr,
      "-subj", `/CN=${commonName}`,
    ], { stdio: "pipe" });

    const args = [
      "x509", "-req", "-in", csr,
      "-CA", caCert, "-CAkey", caKey,
      "-CAcreateserial", "-out", cert,
      "-days", "1",
    ];
    if (san) {
      const extFile = path.join(dir, `${name}.ext`);
      writeFileSync(extFile, `subjectAltName = ${san}\n`, "utf-8");
      args.push("-extfile", extFile);
    }
    execFileSync("openssl", args, { stdio: "pipe" });
    return { key, cert };
  }

  const rootCa = createCa("test-ca");
  const untrustedCa = createCa("untrusted-ca");

  const server = createSignedCert("server", rootCa.key, rootCa.cert, "localhost", "DNS:localhost, IP:127.0.0.1");
  const serverWrong = createSignedCert("server-wronghost", rootCa.key, rootCa.cert, "otherhost", "DNS:otherhost");
  const worker1 = createSignedCert("worker1", rootCa.key, rootCa.cert, "worker-1");
  const worker2 = createSignedCert("worker2", rootCa.key, rootCa.cert, "worker-2");
  const workerUntrusted = createSignedCert("worker-untrusted", untrustedCa.key, untrustedCa.cert, "worker-untrusted");

  const rotatedServer = createSignedCert("rotated-server", rootCa.key, rootCa.cert, "localhost", "DNS:localhost, IP:127.0.0.1");
  const rotatedWorker1 = createSignedCert("rotated-worker1", rootCa.key, rootCa.cert, "worker-1");

  return {
    dir,
    caKey: rootCa.key,
    caCert: rootCa.cert,
    untrustedCaKey: untrustedCa.key,
    untrustedCaCert: untrustedCa.cert,
    serverKey: server.key,
    serverCert: server.cert,
    serverWrongHostKey: serverWrong.key,
    serverWrongHostCert: serverWrong.cert,
    worker1Key: worker1.key,
    worker1Cert: worker1.cert,
    worker2Key: worker2.key,
    worker2Cert: worker2.cert,
    workerUntrustedKey: workerUntrusted.key,
    workerUntrustedCert: workerUntrusted.cert,
    rotatedServerKey: rotatedServer.key,
    rotatedServerCert: rotatedServer.cert,
    rotatedWorker1Key: rotatedWorker1.key,
    rotatedWorker1Cert: rotatedWorker1.cert,
  };
}
