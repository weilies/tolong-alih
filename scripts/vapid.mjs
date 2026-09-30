// Prints a fresh VAPID key pair for Web Push (src/push.js).
//   VAPID_PUBLIC_KEY  -> "vars" in wrangler*.jsonc
//   VAPID_PRIVATE_KEY -> npx wrangler secret put VAPID_PRIVATE_KEY -c <config>
// One pair per environment. Rotating it strands every existing subscription.
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
const b64u = (b) => Buffer.from(b).toString("base64url");
console.log("VAPID_PUBLIC_KEY=" + b64u(raw));
console.log("VAPID_PRIVATE_KEY=" + (await crypto.subtle.exportKey("jwk", privateKey)).d);
