import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const forge = require("node-forge");

test("node-forge rejects RSA DigestInfo with extra nested DigestAlgorithm elements", () => {
  const { privateKey, publicKey } = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 3 });
  const digest = forge.md.sha256.create().update("test message").digest().getBytes();
  const algorithm = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ""),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, "unparsed garbage"),
  ]);
  const digestInfo = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    algorithm,
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, digest),
  ]);
  const signature = privateKey.sign(forge.asn1.toDer(digestInfo).getBytes(), "NONE");
  assert.throws(() => publicKey.verify(digest, signature), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
});

test("node-forge still verifies ordinary SHA-256 RSA signatures", () => {
  const { privateKey, publicKey } = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 3 });
  const digest = forge.md.sha256.create().update("valid message");
  const signature = privateKey.sign(digest);
  assert.equal(publicKey.verify(digest.digest().getBytes(), signature), true);
});
