// Checks a round's key exchange in the browser, the two pairings the MPC
// contract ran before it answered: the round's app key is one scalar on both
// generators, e(pk1, G2) = e(G1, pk2), and big_c is the derived key encrypted
// to it under big_y, e(big_c, G2) = e(H(mpk ‖ app_id), mpk) · e(big_y, pk2).
// Every input is public, so the seal no longer rests on the contracts having
// done it.
import { bls12_381 as bls } from 'https://esm.sh/@noble/curves@1.9.7/bls12-381';
import { sha3_256 } from 'https://esm.sh/@noble/hashes@1.8.0/sha3';

const MPC_CONTRACT = 'v1.signer-prod.testnet';
const CKD_DOMAIN_ID = 2;
// Same constants as near/mpc (contract/src/primitives/ckd.rs, crypto-types/src/kdf.rs).
const DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';
const APP_ID_PREFIX = 'near-mpc v0.1.0 app_id derivation:';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 255n));
  for (let i = 0; i < s.length && s[i] === '1'; i++) out.unshift(0);
  return new Uint8Array(out);
}
function keyBytes(s, prefix, len) {
  if (!s.startsWith(prefix)) throw new Error(`expected ${prefix}`);
  const b = base58(s.slice(prefix.length));
  if (b.length !== len) throw new Error(`${prefix} key is ${b.length} bytes, not ${len}`);
  return b;
}

// The domain-2 key every CKD response is checked against; read once per page load.
let mpk = null;
async function mpcKey() {
  if (!mpk) {
    const state = await view('state', {}, MPC_CONTRACT);
    const running = state.Running || (state.Resharing && state.Resharing.previous_running_state);
    const domain = running.keyset.domains.find(d => d.domain_id === CKD_DOMAIN_ID);
    const bytes = keyBytes(domain.key.Bls12381.public_key, 'bls12381g2:', 96);
    mpk = { bytes, point: bls.G2.ProjectivePoint.fromHex(bytes) };
  }
  return mpk;
}

const g1 = s => bls.G1.ProjectivePoint.fromHex(keyBytes(s, 'bls12381g1:', 48));
const g2 = s => bls.G2.ProjectivePoint.fromHex(keyBytes(s, 'bls12381g2:', 96));
window.verifyKey = async (account, path, ckd) => {
  const { bytes, point } = await mpcKey();
  const F = bls.fields.Fp12, G1 = bls.G1.ProjectivePoint.BASE, G2 = bls.G2.ProjectivePoint.BASE;
  const pk2 = g2(ckd.pk2);
  if (!F.eql(bls.pairing(g1(ckd.pk1), G2), bls.pairing(G1, pk2))) return false;
  const appId = sha3_256(new TextEncoder().encode(`${APP_ID_PREFIX}${account},${path}`));
  const h = bls.G1.hashToCurve(new Uint8Array([...bytes, ...appId]), { DST });
  return F.eql(bls.pairing(g1(ckd.big_c), G2), F.mul(bls.pairing(h, point), bls.pairing(g1(ckd.big_y), pk2)));
};
window.dispatchEvent(new Event('ckd-ready'));
