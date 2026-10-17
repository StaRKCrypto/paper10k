#!/usr/bin/env node
// FORK REHEARSAL (not a public-testnet deployment): anvil --fork-url <HyperEVM testnet 998>, chain id 998, real forked state,
// HyperCore precompile addresses 0x807/0x80e replaced by MockHyperCore (Foundry has no HyperCore precompiles), seeded from the LIVE testnet values.
// Owner = the throwaway key file (read inside this process, never printed); gas is conjured with anvil_setBalance (fork only, worthless).
// Users/keeper = anvil's PUBLIC dev mnemonic accounts (worthless). Writes ../testnet-run-fork.json (no keys).
import { spawn, execSync } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, defineChain, formatUnits } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

const SRC = process.env.FORK_URL || 'https://rpc.hyperliquid-testnet.xyz/evm', PORT = 8547, RPC = `http://127.0.0.1:${PORT}`;
const MN = 'test test test test test test test test test test test junk', acct = (i) => mnemonicToAccount(MN, { addressIndex: i });
const KEYFILE = process.env.TESTNET_KEY_FILE || '/home/box/secrets/p10k-testnet.key';
const OKEY = readFileSync(KEYFILE, 'utf8').trim(); const owner = privateKeyToAccount(OKEY.startsWith('0x') ? OKEY : '0x' + OKEY);
const PATH = process.env.PATH + ':' + process.env.HOME + '/.foundry/bin';
const sh = (c, env = {}) => execSync(c, { env: { ...process.env, PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const chain = defineChain({ id: 998, name: 'hyperevm-testnet-fork', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), pollingInterval: 300 });
const wc = (a) => createWalletClient({ account: a, chain, transport: http(RPC) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!ok) fails++; };
const procs = []; const cleanup = () => procs.forEach((p) => { try { p.kill('SIGTERM'); } catch {} }); process.on('exit', cleanup);
const REC = { chain: 'local anvil fork of HyperEVM testnet (chainId 998)', forkSource: SRC, txs: [], gas: {} };

const anvil = spawn('anvil', ['--fork-url', SRC, '--port', String(PORT), '--block-time', '1', '--silent', ...(process.env.GAS_LIMIT ? ['--gas-limit', process.env.GAS_LIMIT] : [])], { env: { ...process.env, PATH }, stdio: 'ignore' }); procs.push(anvil);
for (let i = 0; i < 80; i++) { try { await pc.getBlockNumber(); break; } catch { await sleep(500); } }
const forkBlock = await pc.getBlockNumber(); REC.forkBlock = Number(forkBlock);
check('fork reports chainId 998', (await pc.getChainId()) === 998);
const fund = (a) => pc.request({ method: 'anvil_setBalance', params: [a, '0x' + (10n ** 21n).toString(16)] });
for (const a of [owner.address, ...[1, 2, 3, 4, 5].map((i) => acct(i).address)]) await fund(a);

// ---- live precompile values from the real testnet, then mock precompiles at the real addresses
const live = async (to, i) => (await (await fetch(SRC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: '0x' + i.toString(16).padStart(64, '0') }, 'latest'] }) })).json()).result;
const OPX = '0x0000000000000000000000000000000000000807', BBO = '0x000000000000000000000000000000000000080e';
const realOpx = BigInt(await live(OPX, 0)), r = await live(BBO, 0), realBid = BigInt('0x' + r.slice(2, 66)), realAsk = BigInt('0x' + r.slice(66, 130));
REC.liveSeed = { btc_oraclePx_raw: String(realOpx), btc_bid_raw: String(realBid), btc_ask_raw: String(realAsk), scale: 'raw / 10 = USD (BTC szDecimals 5)' };
const code = '0x' + JSON.parse(readFileSync('../contracts/out/MockHyperCore.sol/MockHyperCore.json', 'utf8')).deployedBytecode.object.replace(/^0x/, '');
for (const a of [OPX, BBO]) await pc.request({ method: 'anvil_setCode', params: [a, code] });
const mockAbi = parseAbi(['function set(uint256,uint64,uint64)', 'function setSingle(bool)']);
const sendRaw = async (account, address, abi, fn, args = [], tag) => {
  const h = await wc(account).writeContract({ address, abi: typeof abi[0] === 'string' ? parseAbi(abi) : abi, functionName: fn, args }); const rc = await pc.waitForTransactionReceipt({ hash: h });
  if (rc.status !== 'success') throw new Error(`tx reverted: ${fn}`);
  REC.txs.push({ step: tag || fn, hash: h, block: Number(rc.blockNumber), gasUsed: Number(rc.gasUsed) }); (REC.gas[tag || fn] ||= []).push(Number(rc.gasUsed)); return rc;
};
await sendRaw(owner, OPX, mockAbi, 'setSingle', [true], 'mock.setSingle');
const setPx = async (f) => { // f = multiplier in 1e6
  const s = (v) => BigInt(v) * BigInt(f) / 1_000_000n;
  await sendRaw(owner, OPX, mockAbi, 'set', [0n, s(realOpx), 0n], 'mock.oraclePx'); await sendRaw(owner, BBO, mockAbi, 'set', [0n, s(realBid), s(realAsk)], 'mock.bbo');
};
await setPx(1_000_000);

// ---- deploy with the real Deploy script on chain 998 => HyperCoreOracle + TestUSDC. Key via env only.
let out; try { out = sh(`cd ${process.cwd()}/../contracts && forge script script/Deploy.s.sol --rpc-url ${RPC} --private-key "$DEPLOYER_KEY" --broadcast 2>&1`, { OWNER: owner.address, CONFIG_DELAY: '300', USE_HYPERCORE_ORACLE: '1', DEPLOYER_KEY: OKEY.startsWith('0x') ? OKEY : '0x' + OKEY }); } catch (e) { console.log('DEPLOY FAILED (output trimmed, key never logged):\n' + String(e.stdout || '').split(OKEY).join('<key>').slice(-1500)); process.exit(2); }
const get = (k) => out.split('\n').find((l) => new RegExp(`^\\s+${k} `).test(l)).trim().split(/\s+/)[1];
const USDC = get('TestUSDC'), ORC = get('Oracle'), PX = get('PAPER10KX'), EX = get('Exchange'); REC.addresses = { owner: owner.address, TestUSDC: USDC, HyperCoreOracle: ORC, PAPER10KX: PX, Exchange: EX, mockOraclePx: OPX, mockBBO: BBO };
console.log(REC.addresses);
const dep = JSON.parse(readFileSync(`../contracts/broadcast/Deploy.s.sol/998/run-latest.json`, 'utf8'));
REC.deployTxs = dep.transactions.map((t, i) => ({ contract: t.contractName, address: t.contractAddress, hash: t.hash, gasUsed: Number(BigInt(dep.receipts[i].gasUsed)) }));
const exAbi = parseAbi(['function proposeMarket(uint32,bool,uint256,uint256)', 'function applyMarket(uint32)', 'function seedPool(uint256)', 'function unpause()', 'function deposit(uint256)', 'function open(uint32,bool,uint256,uint32,uint256) returns (uint256)', 'function markLiquidatable(uint256)', 'function free(address) view returns (uint256)', 'function positions(uint256) view returns (address,uint32,uint16,uint32,bool,uint128,uint128,uint128,uint64,uint32)', 'function marks(uint256) view returns (uint32,uint64)', 'function pool() view returns (uint256)', 'function insurance() view returns (uint256)']);
const usdcAbi = ['function faucet()', 'function approve(address,uint256)', 'function balanceOf(address) view returns (uint256)'];
const oAbi = parseAbi(['function configure(uint32,uint32,uint8)', 'function setGuards(uint256,uint256,address,uint256,uint64)', 'function finalizeBootstrap()', 'function getPrice(uint32) view returns (uint256,uint64)', 'function getLiquidationPrice(uint32,bool) view returns (uint256,uint64)', 'function bootstrapped() view returns (bool)']);
// bootstrap config (instant) -> finalize -> only then unpause. Guards: spread <= 30 bps, mid-vs-oraclePx <= 100 bps (live testnet BTC mid sits ~37 bps from oraclePx, so the default 100 bps passes).
await sendRaw(owner, ORC, oAbi, 'setGuards', [30n, 100n, '0x0000000000000000000000000000000000000000', 100n, 60n], 'oracle.setGuards');
await sendRaw(owner, ORC, oAbi, 'configure', [0, 0, 5], 'oracle.configure(BTC)');
await sendRaw(owner, ORC, oAbi, 'finalizeBootstrap', [], 'oracle.finalizeBootstrap');
check('oracle bootstrapped', await pc.readContract({ address: ORC, abi: oAbi, functionName: 'bootstrapped' }));
const [px0] = await pc.readContract({ address: ORC, abi: oAbi, functionName: 'getPrice', args: [0] }); const [lpL] = await pc.readContract({ address: ORC, abi: oAbi, functionName: 'getLiquidationPrice', args: [0, true] });
REC.oracleReads = { getPrice_BTC_usd: Number(px0) / 1e18, liqPriceLong_BTC_usd: Number(lpL) / 1e18, expectedMidFromLive_usd: Number(realBid + realAsk) / 20 };
check('HyperCoreOracle.getPrice == guarded BBO mid from precompile data', px0 > 0n && Math.abs(Number(px0) / 1e18 - Number(realBid + realAsk) / 20) < 0.01, JSON.stringify(REC.oracleReads));
await sendRaw(owner, PX, ['function acceptOwnership()'], 'acceptOwnership');
await sendRaw(owner, EX, exAbi, 'proposeMarket', [0, true, 10n ** 12n, 10n ** 12n]);
await pc.request({ method: 'evm_increaseTime', params: [301] }); await pc.request({ method: 'evm_mine', params: [] });
await sendRaw(owner, EX, exAbi, 'applyMarket', [0]);
await sendRaw(owner, USDC, usdcAbi, 'faucet'); await sendRaw(owner, USDC, usdcAbi, 'approve', [EX, 10_000_000_000n]); await sendRaw(owner, EX, exAbi, 'seedPool', [10_000_000_000n]);
await sendRaw(owner, EX, exAbi, 'unpause');

// ---- negative checks of the real guard path
const q = (f) => pc.readContract({ address: ORC, abi: oAbi, functionName: 'getPrice', args: [0] });
await sendRaw(owner, BBO, mockAbi, 'set', [0n, realBid / 2n, realAsk], 'mock.bbo(wide)'); const [wide] = await q(); check('guard: absurd spread => price (0,0)', wide === 0n);
await setPx(1_000_000);
await sendRaw(owner, OPX, mockAbi, 'set', [0n, realOpx * 11n / 10n, 0n], 'mock.oraclePx(+10%)'); const [dv] = await q(); check('guard: oraclePx 10% off mid => price (0,0)', dv === 0n);
await setPx(1_000_000); check('guards recover with sane data', (await q())[0] > 0n);

// ---- users open 10000x BTC longs, keeper runs
const users = [1, 3, 4, 5]; const ids = [];
for (const u of users) {
  const a = acct(u);
  await sendRaw(a, USDC, usdcAbi, 'faucet'); await sendRaw(a, USDC, usdcAbi, 'approve', [EX, 1_000_000_000n]); await sendRaw(a, EX, exAbi, 'deposit', [500_000_000n]);
  const rc = await sendRaw(a, EX, exAbi, 'open', [0, true, 20_000_000n, 10_000, 2n ** 255n], 'open(10000x long, 20 USDC)');
  ids.push(BigInt(rc.logs.find((l) => l.address.toLowerCase() === EX.toLowerCase()).topics[1]));
}
console.log('position ids', ids.map(String));
const KEEPER = acct(2), KEEPER_KEY = '0x' + Buffer.from(KEEPER.getHdKey().privateKey).toString('hex');
const view = (fn, args) => pc.readContract({ address: EX, abi: exAbi, functionName: fn, args });
const alive = async (id) => (await view('positions', [id]))[0] !== '0x0000000000000000000000000000000000000000';
const freeBefore = await view('free', [KEEPER.address]), poolB = await view('pool', []), insB = await view('insurance', []);
// adverse move of 1.0%: the live testnet BTC oraclePx sits ~37 bps ABOVE the BBO mid, and a long is only liquidatable when BOTH sources are below its bust price (least-liquidation-favourable of the two), so a 0.03% move is NOT enough on this data (verified: guard working as designed)
await setPx(990_000);
const [lpAfter] = await pc.readContract({ address: ORC, abi: oAbi, functionName: 'getLiquidationPrice', args: [0, true] }); REC.oracleReads.liqPriceLongAfterMove_usd = Number(lpAfter) / 1e18;
const kl = createWriteStream('/tmp/keeper-fork998.log');
const keeper = spawn('node', ['src/cli.mjs'], { env: { ...process.env, PATH, RPC_URL: RPC, EXCHANGE: EX, CHAIN_ID: '998', FROM_BLOCK: String(forkBlock), LOG_CHUNK: '1000', POLL_MS: '500', LOG_LEVEL: 'info', KEEPER_PRIVATE_KEY: KEEPER_KEY }, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(keeper);
let buf = ''; keeper.stdout.on('data', (d) => { buf += d; kl.write(d); }); keeper.stderr.on('data', (d) => { buf += d; kl.write(d); });
for (let i = 0; i < 90; i++) { await sleep(1000); if ((await Promise.all(ids.map(alive))).every((a) => !a)) break; }
await sleep(3000); keeper.kill('SIGTERM');
const ev = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const marks = ev.filter((e) => e.event === 'tx_success' && e.fn === 'markLiquidatable'), liqs = ev.filter((e) => e.event === 'tx_success' && e.fn === 'liquidate');
check('all 4 positions liquidated by keeper', (await Promise.all(ids.map(alive))).every((a) => !a), `marks=${marks.length} liqs=${liqs.length}`);
const gap = ids.map((id) => { const m = marks.find((e) => e.id === id.toString()), l = liqs.find((e) => e.id === id.toString()); return m && l ? Number(BigInt(l.block) - BigInt(m.block)) : null; });
check('>= 2 blocks between mark and liquidate for each', gap.every((g) => g !== null && g >= 2), JSON.stringify(gap));
REC.keeper = { marks: marks.map((e) => ({ id: e.id, hash: e.hash || e.txHash, block: e.block, gasUsed: e.gasUsed })), liquidations: liqs.map((e) => ({ id: e.id, hash: e.hash || e.txHash, block: e.block, gasUsed: e.gasUsed })), blocksBetweenMarkAndLiquidate: gap };
const bounty = (await view('free', [KEEPER.address])) - freeBefore; check('bounty 4 x 0.4 USDC = 1.6 USDC to keeper', bounty === 1_600_000n, formatUnits(bounty, 6));
const house = (await view('pool', [])) - poolB + ((await view('insurance', [])) - insB); check('house got 78.4 USDC', house === 78_400_000n, formatUnits(house, 6));
const pxBal = []; for (const u of users) pxBal.push(await pc.readContract({ address: PX, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [acct(u).address] }));
check('PAPER10KX minted to every liquidated owner', pxBal.every((b) => b > 0n), pxBal.map((b) => formatUnits(b, 18)).join(','));
REC.results = { bountyUSDC: formatUnits(bounty, 6), houseUSDC: formatUnits(house, 6), paper10kxMinted: pxBal.map((b) => formatUnits(b, 18)), positionIds: ids.map(String), failedChecks: fails };
writeFileSync('../testnet-run-fork.json', JSON.stringify(REC, null, 1));
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL FORK REHEARSAL CHECKS PASSED'); cleanup(); process.exit(fails ? 1 : 0);
