// Stake tab: PAPER10KX -> Paper10kStaking, rewards in USDC. Every number is read from the contracts; APR only from real on-chain history.
import { enc, words, toBig, toAddr, fmtUnits } from './abi.js';
export const SS = {
  totalStaked: '0x817b1cd2', staked: '0x98807d84', earned: '0x008cc262', pending: '0x5eebea20', cooldown: '0x787a08a6', totalNotified: '0x89f12b6e',
  totalClaimed: '0xd54ad2a1', rpt: '0xdf136d65', stake: '0xa694fc3a', unstake: '0x2e17de78', withdrawUnstaked: '0x847fdd12', claim: '0x4e71d92d',
  balanceOf: '0x70a08231', allowance: '0xdd62ed3e', approve: '0x095ea7b3', stakerCap: '0x95062bae', stakerLossBps: '0x7d907a26', stakerFeeBps: '0x05bf3b52', staking: '0x4cf088d9',
};
const ACC = 10n ** 36n, YEAR = 365n * 86400n, WIN = 7n * 86400n;
const isZero = (a) => !a || /^0x0{40}$/i.test(a);
export async function loadStake(rpc, chain, d, acct) {
  const call = (to, data, tag = 'latest') => rpc(chain, 'eth_call', [{ to, data }, tag]);
  const n = async (to, sel, ...a) => { try { return toBig((await call(to, enc(sel, ...a))).slice(2, 66)); } catch { return null; } };
  const staking = d.staking || toAddr(words(await call(d.exchange, SS.staking))[0]);
  if (isZero(staking)) return { none: true };
  const S = { staking, totalStaked: await n(staking, SS.totalStaked), cooldown: Number(await n(staking, SS.cooldown) ?? 0),
    totalNotified: await n(staking, SS.totalNotified), totalClaimed: await n(staking, SS.totalClaimed),
    cap: await n(d.exchange, SS.stakerCap), lossBps: Number(await n(d.exchange, SS.stakerLossBps) ?? 0), feeBps: Number(await n(d.exchange, SS.stakerFeeBps) ?? 0) };
  // APR: growth of rewardPerTokenStored over the trailing 7 days (needs historical eth_call; shown as n/a if the RPC can't serve it)
  try {
    const head = await rpc(chain, 'eth_getBlockByNumber', ['latest', false]); const hn = BigInt(head.number), ht = BigInt(head.timestamp);
    const back = hn > 1000n ? hn - 1000n : 0n; const old = await rpc(chain, 'eth_getBlockByNumber', ['0x' + back.toString(16), false]);
    const bt = (ht - BigInt(old.timestamp)) || 1n; let past = hn - (WIN * (hn - back)) / bt; if (past < 1n) past = 1n;
    const pb = await rpc(chain, 'eth_getBlockByNumber', ['0x' + past.toString(16), false]); const span = ht - BigInt(pb.timestamp);
    const r1 = toBig((await call(staking, SS.rpt)).slice(2, 66)), r0 = toBig((await call(staking, SS.rpt, '0x' + past.toString(16))).slice(2, 66));
    if (span > 0n) S.usdcPer1kYear = ((r1 - r0) * 1000n * 10n ** 18n / ACC) * YEAR / span; S.aprSpanDays = Number(span) / 86400;
  } catch { S.usdcPer1kYear = null; }
  if (acct) Object.assign(S, { wallet: await n(d.px, SS.balanceOf, acct), staked: await n(staking, SS.staked, acct), earned: await n(staking, SS.earned, acct),
    allowance: await n(d.px, SS.allowance, acct, staking) });
  if (acct) { try { const w = words(await call(staking, enc(SS.pending, acct))); S.pendAmt = toBig(w[0]); S.unlockAt = Number(toBig(w[1])); } catch {} }
  return S;
}
export const DEMO_STAKE = { demo: true, totalStaked: null, cooldown: 0, cap: 0n, lossBps: 100, feeBps: 0, usdcPer1kYear: null };
export function stakeHtml(S, { sym = 'USDC', account, explorer }) {
  S = S ?? DEMO_STAKE; const demo = !!S.demo, dis = demo || !account ? 'disabled' : '';
  const px = (v) => (v == null ? '—' : fmtUnits(BigInt(v), 18, 2)), us = (v) => (v == null ? '—' : fmtUnits(BigInt(v), 6, 2));
  const share = S.totalStaked && S.staked != null && S.totalStaked > 0n ? Number((S.staked * 1_000_000n) / S.totalStaked) / 10_000 : null;
  let h = `<div class="ccard wide stakecard"><h3>💰 Stake PAPER10KX ${demo ? '<span class="muted">(demo: no deployment on this network, buttons disabled)</span>' : '<span class="up">(live)</span>'}</h3>`;
  if (S.none) return h + `<p class="muted">Staking is not wired on this deployment (exchange.staking() == 0x0).</p></div>`;
  h += `<p class="fine">Stakers earn ${(S.lossBps / 100).toLocaleString()}% of every trader loss${S.feeBps ? ` + ${(S.feeBps / 100).toLocaleString()}% of win fees` : ''}, paid in ${sym}. Rewards come only from real trading flow on-chain: no emissions.</p>`;
  h += `<dl class="quote stakegrid">
    <dt>Your wallet PAPER10KX</dt><dd>${px(S.wallet)}</dd><dt>Your staked</dt><dd><b>${px(S.staked)}</b></dd>
    <dt>Pending rewards</dt><dd class="up"><b>${us(S.earned)} ${sym}</b></dd><dt>Your share of the pool</dt><dd>${share == null ? '—' : share.toLocaleString() + '%'}</dd>
    <dt>Total staked</dt><dd>${px(S.totalStaked)}</dd><dt>Staker cap (per sweep)</dt><dd>${S.cap == null ? '—' : S.cap === 0n ? 'none' : us(S.cap) + ' ' + sym}</dd>
    <dt>Paid to stakers (all time)</dt><dd>${us(S.totalNotified)} ${sym} · claimed ${us(S.totalClaimed)}</dd>
    <dt>Cooldown</dt><dd>${S.cooldown ? `${S.cooldown}s after unstake` : 'none: unstake is immediate'}</dd>
    <dt>Real yield (trailing)</dt><dd>${S.usdcPer1kYear == null ? '<span class="muted">n/a until rewards accrue on-chain</span>' : `${us(S.usdcPer1kYear)} ${sym} / year per 1,000 staked <span class="muted">(last ${S.aprSpanDays?.toFixed(1)} d)</span>`}</dd></dl>`;
  if (S.pendAmt) h += `<div class="cbanner">Unstaking ${px(S.pendAmt)} PAPER10KX, unlocks ${new Date(S.unlockAt * 1000).toLocaleString()}. <button class="go sm" data-act="sWithdraw" ${dis || (S.unlockAt * 1000 > Date.now() ? 'disabled' : '')}>Withdraw</button></div>`;
  h += `<div class="row"><input id="sAmt" inputmode="decimal" placeholder="PAPER10KX amount" ${dis}><button class="ghost sm" data-act="sMax" ${dis}>Max</button></div>
    <div class="chips"><button class="go long" data-act="sStake" ${dis}>Stake</button><button class="ghost" data-act="sUnstake" ${dis}>Unstake</button><button class="go" data-act="sClaim" ${dis}>Claim ${sym}</button></div>`;
  if (!demo && !account) h += `<p class="muted">Connect a wallet to stake.</p>`;
  if (!demo && explorer) h += `<p class="fine">Contract: <a href="${explorer}/address/${S.staking}" target="_blank" rel="noopener"><code>${S.staking}</code></a> (no owner, no admin, immutable).</p>`;
  return h + `</div>`;
}
