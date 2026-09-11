// Checks a round's key in the browser: e(big_c, G2) = e(H(mpk ‖ app_id), mpk),
// the pairing the MPC contract ran before it returned the key. Every input is
// public, so the seal no longer rests on the contracts having done it.
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

window.verifyKey = async (account, path, bigC) => {
  const { bytes, point } = await mpcKey();
  const appId = sha3_256(new TextEncoder().encode(`${APP_ID_PREFIX}${account},${path}`));
  const h = bls.G1.hashToCurve(new Uint8Array([...bytes, ...appId]), { DST });
  const c = bls.G1.ProjectivePoint.fromHex(keyBytes(bigC, 'bls12381g1:', 48));
  return bls.fields.Fp12.eql(bls.pairing(c, bls.G2.ProjectivePoint.BASE), bls.pairing(h, point));
};
window.dispatchEvent(new Event('ckd-ready'));
